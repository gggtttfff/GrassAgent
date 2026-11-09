// src/cli.ts
// 拼装层 —— 把 llm / agent / tui / tools / config 粘起来，是唯一入口。
// session 持久化：每轮结束把 context.messages 写进 ~/.grassagent/sessions.db。

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from './agent.ts'
import { Tui } from './tui.ts'
import { builtinTools } from './tools.ts'
import { createAskUserTool } from './askUser.ts'
import { loadConfig, ConfigError, type AgentConfig } from './config.ts'
import { createLoggerFromConfig } from './logger.ts'
import { createTransport } from './transport.ts'
import { SessionStore, generateSessionId } from './sessionStore.ts'
import { SlashCommandRegistry } from './slashCommands.ts'
import { buildSessionChoices } from './sessionPicker.ts'
import { canUseInteractiveTerminal } from './nonInteractiveTerminal.ts'
import type { Model, Context } from './llm.ts'

/** 固定 system prompt */
const SYSTEM_PROMPT =
  '你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。先阅读再修改，修改后可运行命令验证。' +
  '信息不足，或有多种做法必须由用户决定时，调用 ask_user 提问并等待回答。能从代码或命令里查到的不要问，一次只问一个问题。' +
  '如果 ask_user 返回没有用户可以回答，不要再问，按现有信息继续。'

async function main() {
  // 配置先加载并校验:启动阶段就报错，比第一次调 API 失败好排查
  let config: AgentConfig
  try {
    config = await loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[grassagent] ${error.message}`)
      for (const issue of error.issues) console.error(issue)
      console.error('提示: 可在 .env 里配置这些变量，参考 .env.example')
      process.exit(1)
    }
    throw error
  }

  const logger = createLoggerFromConfig(config)

  const model: Model = {
    apiKey: config.ApiKey,
    model: config.Model,
    baseUrl: config.BaseUrl,
    maxTokens: config.MaxTokens,
  }

  // 传输层在进程内共享，保证并发闸门对所有请求生效
  const transport = createTransport({
    timeoutMs: config.RequestTimeoutMs,
    maxRetries: config.MaxRetries,
    retryBaseDelayMs: config.RetryBaseDelayMs,
    retryMaxDelayMs: config.RetryMaxDelayMs,
    maxConcurrency: config.MaxConcurrency,
    logger,
  })

  // 会话存储:SQLite,多进程可同时读写同一个库。
  // 每个进程用独立 sessionId,各存各的会话,互不干扰。
  const sessionId = config.SessionId ?? generateSessionId()
  const sessionStore = new SessionStore({
    databasePath: config.SessionDatabasePath,
    sessionId,
  })
  logger.info({ sessionId, databasePath: config.SessionDatabasePath }, '会话存储已打开')

  // 初始化 context：system prompt 用专用字段，messages 从会话库加载
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: sessionStore.load(),
  }

  // 工具的文件访问被限制在工作区内。
  // ask_user 不碰文件，它只是把「问用户」交给终端，所以单独接在后面。
  const fileTools = await builtinTools({
    workspace: config.Workspace,
    commandTimeoutMs: config.CommandTimeoutMs,
  })
  const tui = new Tui()
  const tools = [
    ...fileTools,
    createAskUserTool({
      ask: (question, signal) => tui.ask(question, signal),
      logger,
    }),
  ]
  // 进程收尾:停掉 TUI、关掉数据库。
  // tui.stop() 必须调——TUI 接管了终端原始模式,
  // 不清理的话退出后终端状态会留在那儿,后续命令看着像失灵了。
  const shutdown = (): void => {
    // 先把最后一帧渲染出来——渲染是异步调度的,
    // 不 flush 就退出的话,输出会缺最后一截
    tui.flush()
    tui.stop()
    sessionStore.close()
  }

  // 回合是否在跑。非交互模式(管道输入)下,stdin 读完了不代表能退出——
  // 那一行触发的回合可能还在跑,得等它跑完。
  let roundRunning = false
  let inputClosed = false

  tui.onInputClosed(() => {
    inputClosed = true
    // 空闲时(没有回合在跑)直接退
    if (!roundRunning) {
      shutdown()
      process.exit(0)
    }
  })

  // ---- 斜杠命令 ----
  // 命令在本地执行,不发给模型。/clear 和 /new 会改会话状态,
  // 所以它们要能拿到 context 和 sessionStore——这里用闭包传进去。
  const commandRegistry = new SlashCommandRegistry()

  commandRegistry.register({
    name: 'clear',
    description: '清空当前对话,保留会话',
    execute: async () => {
      await sessionStore.sync(context.messages)
      context.messages = []
      context.compaction = undefined
      tui.clearTranscript()
      return '对话已清空'
    },
  })

  commandRegistry.register({
    name: 'new',
    description: '开一个新会话',
    execute: async () => {
      const newSessionId = sessionStore.createSession(context.messages)
      context.messages = []
      context.compaction = undefined
      tui.clearTranscript()
      logger.info({ sessionId: newSessionId }, '已创建新会话')
      return `已创建新会话 ${newSessionId}`
    },
  })

  commandRegistry.register({
    name: 'sessions',
    description: '列出所有会话',
    execute: async () => {
      const sessions = sessionStore.listSessionDetails()
      if (sessions.length === 0) return '还没有任何会话'
      const lines = sessions.map((session) => {
        const marker = session.id === sessionStore.sessionId ? '*' : ' '
        return `${marker} ${session.id}  (${session.messageCount} 条消息)`
      })
      return lines.join('\n')
    },
  })

  commandRegistry.register({
    name: 'resume',
    description: '切换到别的会话',
    argumentHint: '[会话ID]',
    execute: async (argument) => {
      const sessions = sessionStore.listSessionDetails()
      if (sessions.length === 0) return '还没有任何会话'

      // 给了 ID 就直接切
      if (argument) {
        const target = sessions.find((session) => session.id === argument)
        if (!target) return `找不到会话 ${argument}`
        return await switchToSession(target.id)
      }

      // 没给 ID:交互模式弹选择器,非交互模式列出来让用户自己挑
      if (!canUseInteractiveTerminal()) {
        return '请指定会话 ID:' + sessions.map((session) => session.id).join(' ')
      }

      // 选择器是异步的——用户什么时候选中不确定,
      // 所以这里先返回空,选中后的动作在回调里做。
      tui.showSessionPicker(
        buildSessionChoices(sessions, sessionStore.sessionId),
        (sessionId) => {
          void switchToSession(sessionId).then((message) => tui.printNotice(message))
        },
        () => tui.printNotice('已取消'),
      )
      return ''
    },
  })

  // 切换会话:存盘当前会话,切过去,载入目标会话的历史
  const switchToSession = async (targetSessionId: string): Promise<string> => {
    if (targetSessionId === sessionStore.sessionId) return '已经在该会话中'
    sessionStore.switchSession(targetSessionId, context.messages)
    context.messages = sessionStore.load()
    // 压缩状态跟着会话走——不同会话的历史长度不一样
    context.compaction = undefined
    tui.clearTranscript()
    logger.info({ sessionId: targetSessionId }, '已切换会话')
    return `已切换到会话 ${targetSessionId}(${context.messages.length} 条消息)`
  }

  // 命令名补全。交互模式才有意义——非交互模式没键盘。
  tui.setSlashCommands(
    commandRegistry.all().map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
    })),
    config.Workspace,
  )

  // 每轮：用户输入 → 斜杠命令 or runAgent → 事件转发到 TUI → 持久化。
  // 回合进行中到达的后续行先排队。提问会把其中一行当成回答，
  // 没被取走的行在本轮结束后按顺序再开一轮，而不是并发挤进来。
  const runInput = async (initialText: string): Promise<void> => {
    let pending: string | undefined = initialText
    while (pending !== undefined) {
      const text = pending
      pending = undefined
      roundRunning = true
      try {
        // 斜杠命令在本地执行,不发给模型
        const commandResult = await commandRegistry.execute(text)
        if (commandResult !== null) {
          if (commandResult) tui.printNotice(commandResult)
        } else {
          context.messages.push({ role: 'user', content: text })

          tui.setBusy(true)
          const ctrl = new AbortController()
          tui.onAbort(() => ctrl.abort())

          for await (const ev of runAgent(model, context, tools, ctrl.signal, {
            transport,
            logger,
            toolExecution: config.ToolExecution,
            compaction: {
              contextWindow: config.ContextWindow,
              reserveTokens: config.CompactReserveTokens,
              keepRecentTokens: config.CompactKeepRecentTokens,
            },
          })) {
            switch (ev.type) {
              case 'assistant_text': tui.printText(ev.delta); break
              case 'tool_call': tui.printToolCall(ev.name, ev.args); break
              case 'tool_result': tui.printToolResult(ev.name, ev.result); break
              case 'turn_end':
                // 收尾:把流式文本换成排好版的 markdown
                tui.finishTurn()
                if (ev.stopReason === 'max_tokens') tui.printNotice('[输出被 max_tokens 截断]')
                if (ev.stopReason === 'aborted') tui.printNotice('[已打断]')
                if (ev.stopReason === 'error') tui.printError('[执行出错]')
                break
            }
          }

          await sessionStore.sync(context.messages)
        }
      } catch (e) {
        logger.error({ errorMessage: (e as Error).message }, '回合执行失败')
        tui.printError((e as Error).message)
      } finally {
        roundRunning = false
        tui.setBusy(false)
        // 下一行在让出事件循环之前就拿到，避免 EOF 回调看见「空闲」把进程退掉
        pending = tui.takeNextHeldLine()
      }
    }

    // 输入已经读完且排队的行都跑完了,这才是能退的时候
    if (inputClosed) {
      shutdown()
      process.exit(0)
    }
  }

  tui.bindSubmit((text) => {
    void runInput(text)
  })

  tui.printHeader('GrassAgent 已启动。输入内容后回车，Ctrl+C 打断当前回合。需要你决定时会停下来提问。')
  tui.start()

  process.once('exit', shutdown)
  process.once('SIGINT', () => {
    // TUI 在 raw 模式下自己拦 Ctrl+C,能走到这里说明不是打断当前回合,
    // 是用户想退出进程。
    shutdown()
    process.exit(130)
  })
}

function entryFilePath(entryArgument: string): string {
  if (entryArgument.startsWith('file:')) return fileURLToPath(entryArgument)
  return path.resolve(entryArgument)
}

// 直接运行才启动。调试器在 Windows 上给出的 argv 和 import.meta.url 经常对不齐，只比字符串会静默退出。
function isDirectRun(): boolean {
  const moduleMeta = import.meta as ImportMeta & { main?: boolean }
  if (moduleMeta.main) return true

  const entryArgument = process.argv[1]
  if (!entryArgument) return false
  try {
    const entryPath = entryFilePath(entryArgument)
    const currentPath = fileURLToPath(import.meta.url)
    if (entryPath.toLowerCase() === currentPath.toLowerCase()) return true
    // 路径格式不一致时，调试器仍会把入口文件名放在 argv
    const entryName = path.basename(entryPath).toLowerCase()
    return entryName === 'cli.ts' || entryName === 'cli.js'
  } catch (error) {
    console.error(`[grassagent] 无法判断入口: ${(error as Error).message}`)
    return false
  }
}

// 调试器经常改 argv，入口判断失败时什么都不打印就退出。判断失败也启动，避免界面空白。
if (!isDirectRun()) {
  console.error(`[grassagent] 入口路径未对上，仍继续启动。argv=${process.argv[1] ?? ''}`)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
