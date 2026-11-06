// src/cli.ts
// 拼装层 —— 把 llm / agent / tui / tools / config 粘起来，是唯一入口。
// session 持久化：每轮结束把 context.messages 写进 ~/.grassagent/sessions.db。

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from './agent.ts'
import { Tui } from './tui.ts'
import { builtinTools } from './tools.ts'
import { loadConfig, ConfigError, type AgentConfig } from './config.ts'
import { createLoggerFromConfig } from './logger.ts'
import { createTransport } from './transport.ts'
import { SessionStore, generateSessionId } from './sessionStore.ts'
import type { Model, Context } from './llm.ts'

/** 固定 system prompt */
const SYSTEM_PROMPT = '你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。先阅读再修改，修改后可运行命令验证。'

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
  // 每个进程用独立 sessionId,各存各的会话,互不干扰——
  // 不像之前的锁文件方案会拒绝第二个实例。
  const sessionId = config.SessionId ?? generateSessionId()
  const sessionStore = new SessionStore({
    databasePath: config.SessionDatabasePath,
    sessionId,
  })
  logger.info({ sessionId, databasePath: config.SessionDatabasePath }, '会话存储已打开')

  // 进程退出时关闭数据库,确保数据落盘
  process.once('exit', () => {
    sessionStore.close()
  })

  // 初始化 context：system prompt 用专用字段，messages 从会话库加载
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: sessionStore.load(),
  }

  // 工具的文件访问被限制在工作区内
  const tools = await builtinTools({
    workspace: config.Workspace,
    commandTimeoutMs: config.CommandTimeoutMs,
  })
  const tui = new Tui()

  // 每轮：用户输入 → runAgent → 事件转发到 TUI → 持久化
  tui.onPrompt(async (text) => {
    try {
      context.messages.push({ role: 'user', content: text })

      tui.setBusy(true)
      const ctrl = new AbortController()
      tui.onAbort(() => ctrl.abort())  // 每轮新建 AbortController，需重新注册回调指向新的 controller

      for await (const ev of runAgent(model, context, tools, ctrl.signal, { transport, logger })) {
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call': tui.printToolCall(ev.name, ev.args); break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'turn_end':
            if (ev.stopReason === 'max_tokens') tui.printText('\n[output truncated by max_tokens]')
            if (ev.stopReason === 'error') tui.printText('\n[error occurred]')
            tui.printTurnEnd()
            break
        }
      }

      await sessionStore.sync(context.messages)
    } catch (e) {
      logger.error({ errorMessage: (e as Error).message }, '回合执行失败')
      console.error(`\n[error] ${(e as Error).message}`)
    } finally {
      tui.setBusy(false)
    }
  })

  console.log('GrassAgent 已启动。输入内容后回车。')
  tui.start()

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
