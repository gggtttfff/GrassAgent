// src/logger.ts
// 日志层 —— 包装 pino,输出结构化 JSON。
// 默认写 stderr,避免污染 TUI 的终端输出。
//
// 注意 pino 的参数顺序:对象必须在第一个参数位置,
// 写成 logger.info('消息', {字段}) 会静默丢掉字段——这是 pino 的既定行为,不是 bug。

import { Writable } from 'node:stream'
import pino, { type Logger } from 'pino'
import type { AgentConfig } from './config.ts'

export type { Logger }

// 日志里不应该出现的字段:密钥、鉴权头
const REDACT_PATHS = [
  'apiKey',
  'apikey',
  'authorization',
  '*.apiKey',
  'req.headers.authorization',
  'headers.authorization',
]

export interface LoggerOptions {
  level: string
  format: 'json' | 'pretty'
  // 日志输出目标:文件路径或自定义流,不填则输出到 stderr
  destination?: string | { write(message: string): void }
}

// 创建一个 logger。
// pretty 格式不引第三方 pretty 打印器,而是自己拼一行文本,保持依赖最少。
export function createLogger(options: LoggerOptions): Logger {
  const baseOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'grassagent' },
    // 异常对象要序列化出 stack,否则排障时看不到调用链
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  }

  if (options.format === 'pretty') {
    return pino(baseOptions, createPrettyDestination(options.destination))
  }
  // pino 的第二个参数只接受 DestinationStream,文件路径要用 destination() 转换
  if (options.destination) {
    if (typeof options.destination === 'string') {
      return pino(baseOptions, pino.destination(options.destination))
    }
    return pino(baseOptions, options.destination)
  }
  return pino(baseOptions, process.stderr)
}

// pretty 输出目标:把每条 JSON 日志转成一行可读文本。
// pino 的 DestinationStream 只需要 write 方法,不需要完整的 Writable。
function createPrettyDestination(
  destination?: string | { write(message: string): void },
): { write(message: string): void } {
  // 指定了输出目标就往那里写,否则写 stderr
  const target = destination
    ? typeof destination === 'string'
      ? pino.destination(destination)
      : destination
    : process.stderr

  return {
    write(message: string): void {
      for (const line of message.split('\n')) {
        if (!line.trim()) continue
        target.write(formatPrettyLine(line))
      }
    },
  }
}

// pino 的默认 level 是数值,转成可读名字
const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

// 把一行 JSON 日志格式化成 "[级别] 消息 键=值" 的形式
function formatPrettyLine(jsonLine: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonLine) as Record<string, unknown>
  } catch {
    return jsonLine
  }

  const rawLevel = parsed.level
  const level = typeof rawLevel === 'number'
    ? (LEVEL_NAMES[rawLevel] ?? String(rawLevel))
    : String(rawLevel ?? 'info')
  const message = String(parsed.msg ?? '')
  const time = typeof parsed.time === 'number' ? new Date(parsed.time).toISOString().slice(11, 23) : ''

  const reserved = new Set(['level', 'msg', 'time', 'pid', 'hostname', 'service'])
  const details = Object.entries(parsed)
    .filter(([key]) => !reserved.has(key))
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)

  return `[${time}] ${level.toUpperCase().padEnd(5)} ${message}${details.length ? ' ' + details.join(' ') : ''}\n`
}

// 从配置创建 logger,顺带把启动时的关键配置打出来便于排障。
export function createLoggerFromConfig(config: AgentConfig): Logger {
  const logger = createLogger({
    level: config.LogLevel,
    format: config.LogFormat,
  })
  logger.info({
    model: config.Model,
    baseUrl: config.BaseUrl,
    workspace: config.Workspace,
    maxTokens: config.MaxTokens,
    maxRetries: config.MaxRetries,
    maxConcurrency: config.MaxConcurrency,
  }, 'grassagent 启动')
  return logger
}
