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
import { appendHookContext, createHookRunner, type HookRunner } from './hooks.ts'
import { defaultHooksFilePath, HookConfigError, loadHooksFile } from './hookConfig.ts'
import {
  appendProjectInstructions,
  discoverProjectInstructions,
  formatInstructionReport,
  summarizeInstructions,
} from './projectInstructions.ts'
import {
  BundleError,
  defaultBundlePath,
  parseExportArgument,
  parseImportArgument,
  readBundleFile,
  resolveBundlePath,
  writeBundleFile,
} from './sessionBundle.ts'
import { messagesArePaired } from './messages.ts'
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

  // 初始化 context：system prompt 用专用字段，messages 从会话库加载。
  // 项目里其他工具的规则接着拼在后面。识别失败不挡启动,否则一个坏文件会让整个程序起不来。
  let instructionReport = '项目规则识别已关闭'
  let instructionNotice = ''
  let systemPrompt = SYSTEM_PROMPT
  if (config.LoadProjectInstructions) {
    try {
      const catalog = await discoverProjectInstructions(config.Workspace, {
        warn: (object, message) => logger.warn(object, message),
        info: (object, message) => logger.info(object, message),
      })
      systemPrompt = appendProjectInstructions(SYSTEM_PROMPT, catalog.promptSection)
      instructionReport = formatInstructionReport(catalog.instructions)
      if (catalog.instructions.length > 0) instructionNotice = summarizeInstructions(catalog.instructions)
    } catch (error) {
      instructionReport = '识别项目规则失败,本次不加载外部规则'
      instructionNotice = instructionReport
      logger.error({ errorMessage: (error as Error).message }, '识别项目规则失败,继续启动')
    }
  }

  const context: Context = {
    systemPrompt,
    messages: sessionStore.load(),
  }

  // 工具的文件访问被限制在工作区内。
  // ask_user 不碰文件，它只是把「问用户」交给终端，所以单独接在后面。
  const fileTools = await builtinTools({
    workspace: config.Workspace,
    commandTimeoutMs: config.CommandTimeoutMs,
  })

  // 钩子配置。默认文件可以不存在;写了但格式不对要在启动时失败。
  const hooksPath = config.HooksPath ?? defaultHooksFilePath(config.Workspace)
  let hookRunner: HookRunner
  try {
    const definitions = await loadHooksFile(hooksPath, { optional: config.HooksPath === undefined })
    hookRunner = createHookRunner(definitions, {
      sessionId,
      cwd: config.Workspace,
      defaultTimeoutMs: config.HookTimeoutMs,
      logger,
    })
    if (definitions.length > 0) {
      logger.info({ hooksPath, hookCount: definitions.length }, '钩子已加载')
    }
  } catch (error) {
    if (error instanceof HookConfigError) {
      console.error(`[grassagent] ${error.message}`)
      for (const issue of error.issues) console.error(issue)
      sessionStore.close()
      process.exit(1)
    }
    throw error
  }

  const sessionStart = await hookRunner.run({ event: 'SessionStart' })
  if (sessionStart.blocked || sessionStart.preventContinuation) {
    console.error(`[grassagent] 会话被钩子拒绝: ${sessionStart.reason ?? 'Blocked by hook'}`)
    for (const message of sessionStart.systemMessages) console.error(`[grassagent] ${message}`)
    sessionStore.close()
    process.exit(1)
  }
  for (const errorMessage of sessionStart.errors) console.error(`[grassagent] ${errorMessage}`)
  if (sessionStart.additionalContext) {
    context.systemPrompt = appendHookContext(context.systemPrompt ?? '', sessionStart.additionalContext)
  }
  // 会话真正起来之后,退出时才跑 SessionEnd。启动被拒绝不算一次会话。
  let sessionStarted = true
  const sessionNotices = sessionStart.systemMessages

  const tui = new Tui()
  const tools = [
    ...fileTools,
    createAskUserTool({
      ask: (question, signal) => tui.ask(question, signal),
      logger,
    }),
  ]
  // 进程收尾:先跑 SessionEnd,再停掉 TUI、关掉数据库。
  // tui.stop() 必须调——TUI 接管了终端原始模式,
  // 不清理的话退出后终端状态会留在那儿,后续命令看着像失灵了。
  // process 的 exit 事件里不能 await,所以钩子只走显式退出路径。
  let cleanedUp = false
  const cleanupSync = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    tui.flush()
    tui.stop()
    sessionStore.close()
  }
  const shutdown = async (): Promise<void> => {
    if (sessionStarted) {
      sessionStarted = false
      try {
        await hookRunner.run({ event: 'SessionEnd' })
      } catch (error) {
        logger.error({ errorMessage: (error as Error).message }, 'SessionEnd 钩子失败')
      }
    }
    cleanupSync()
  }

  // 回合是否在跑。非交互模式(管道输入)下,stdin 读完了不代表能退出——
  // 那一行触发的回合可能还在跑,得等它跑完。
  let roundRunning = false
  let inputClosed = false

  tui.onInputClosed(() => {
    inputClosed = true
    // 空闲时(没有回合在跑)直接退
    if (!roundRunning) {
      void shutdown().finally(() => process.exit(0))
    }
  })

  // 空闲时的 Ctrl+C 也走同一条收尾,SessionEnd 才有机会跑。
  tui.onExit(() => {
    void shutdown().finally(() => process.exit(0))
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

  commandRegistry.register({
    name: 'export',
    description: '把会话导出成可带走的文件',
    argumentHint: '[路径] [--session 会话ID]',
    execute: async (argument) => {
      const parsed = parseExportArgument(argument)
      if (parsed.error) return parsed.error
      // 先落盘,否则最后一轮还在内存里,带走的是旧对话
      await sessionStore.sync(context.messages)
      const filePath = parsed.filePath
        ? resolveBundlePath(parsed.filePath, config.Workspace)
        : defaultBundlePath(config.Workspace)
      if (path.resolve(filePath) === path.resolve(config.SessionDatabasePath)) {
        return '不能把导出发到会话数据库上,换一个路径'
      }
      const snapshots = parsed.sessionId
        ? [sessionStore.readSession(parsed.sessionId)].flatMap((snapshot) => snapshot ? [snapshot] : [])
        : sessionStore.listSnapshots()
      if (parsed.sessionId && snapshots.length === 0) return `找不到会话 ${parsed.sessionId}`
      const unpaired = snapshots.filter((snapshot) => !messagesArePaired(snapshot.messages))
      try {
        await writeBundleFile(filePath, snapshots)
      } catch (error) {
        if (error instanceof BundleError) return `导出失败:${error.message}`
        throw error
      }
      logger.info({ filePath, sessionCount: snapshots.length }, '会话已导出')
      const warning = unpaired.length > 0
        ? `\n有 ${unpaired.length} 个会话的 tool_call 配不上对,文件已写出,但导回时会被拒绝`
        : ''
      return `已导出 ${snapshots.length} 个会话到 ${filePath}${warning}`
    },
  })

  commandRegistry.register({
    name: 'import',
    description: '从文件导回会话',
    argumentHint: '<路径> [--replace]',
    execute: async (argument) => {
      const parsed = parseImportArgument(argument)
      if (parsed.error || !parsed.filePath) return parsed.error ?? 'import 需要文件路径'
      await sessionStore.sync(context.messages)
      const filePath = resolveBundlePath(parsed.filePath, config.Workspace)
      let sessions
      try {
        sessions = await readBundleFile(filePath)
      } catch (error) {
        if (error instanceof BundleError) return `导入失败:${error.message}`
        throw error
      }
      const mode = parsed.replace ? 'replace' : 'merge'
      let imported = 0
      let replaced = 0
      let skipped = 0
      let currentTouched = false
      for (const session of sessions) {
        const outcome = sessionStore.importSession(session, mode)
        if (outcome === 'imported') imported++
        else if (outcome === 'replaced') replaced++
        else skipped++
        if (session.id === sessionStore.sessionId && outcome !== 'skipped') currentTouched = true
      }
      // 覆盖了当前会话就必须从库里重新载入。
      // 再拿旧的 context.messages 去 sync,会把刚导进来的内容盖掉。
      if (currentTouched) {
        context.messages = sessionStore.load()
        context.compaction = undefined
        tui.clearTranscript()
      }
      logger.info({ filePath, imported, replaced, skipped, mode }, '会话已导入')
      return `导入完成:新增 ${imported},覆盖 ${replaced},跳过 ${skipped}`
    },
  })

  commandRegistry.register({
    name: 'instructions',
    description: '列出识别到的规则和提示词',
    execute: () => instructionReport,
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
          tui.setBusy(true)
          const ctrl = new AbortController()
          tui.onAbort(() => ctrl.abort())

          const promptEffect = await hookRunner.run({ event: 'UserPromptSubmit', prompt: text }, ctrl.signal)
          for (const message of promptEffect.systemMessages) tui.printNotice(message)
          for (const errorMessage of promptEffect.errors) tui.printError(errorMessage)
          if (promptEffect.aborted || ctrl.signal.aborted) {
            tui.printNotice('[已打断]')
          } else if (promptEffect.blocked || promptEffect.preventContinuation) {
            tui.printNotice(promptEffect.reason ?? '已被钩子拦截')
          } else {
            context.messages.push({
              role: 'user',
              content: appendHookContext(text, promptEffect.additionalContext),
            })

            for await (const ev of runAgent(model, context, tools, ctrl.signal, {
              transport,
              logger,
              toolExecution: config.ToolExecution,
              compaction: {
                contextWindow: config.ContextWindow,
                reserveTokens: config.CompactReserveTokens,
                keepRecentTokens: config.CompactKeepRecentTokens,
              },
              hooks: hookRunner,
            })) {
              switch (ev.type) {
                case 'assistant_text': tui.printText(ev.delta); break
                case 'tool_call': tui.printToolCall(ev.name, ev.args); break
                case 'tool_result': tui.printToolResult(ev.name, ev.result); break
                case 'hook_notice':
                  if (ev.level === 'error') tui.printError(ev.message)
                  else tui.printNotice(ev.message)
                  break
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

    // 输入已经读完且排队的行都跑完了,这才是能退的时候。
    // SessionEnd 要先跑完,不能在 exit 事件里 await。
    if (inputClosed) {
      await shutdown()
      process.exit(0)
    }
  }

  tui.bindSubmit((text) => {
    void runInput(text)
  })

  tui.printHeader('GrassAgent 已启动。输入内容后回车，Ctrl+C 打断当前回合。需要你决定时会停下来提问。')
  if (instructionNotice) tui.printNotice(instructionNotice)
  for (const message of sessionNotices) tui.printNotice(message)
  tui.start()

  process.once('exit', cleanupSync)
  process.once('SIGINT', () => {
    // TUI 在 raw 模式下自己拦 Ctrl+C,能走到这里说明不是打断当前回合,
    // 是用户想退出进程。
    void shutdown().finally(() => process.exit(130))
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
