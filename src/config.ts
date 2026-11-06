// src/config.ts
// 配置层 —— 集中定义所有环境变量,读取 .env 后用 zod 校验。
// 校验失败要在启动阶段就报错,而不是等到第一次调 API 才暴露。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// 环境变量名统一前缀,避免和宿主环境里其他变量撞名
const ENV_PREFIX = 'GRASSAGENT_'

// 数值型环境变量:空字符串视为未设置,交给 default。
// 直接用 z.coerce.number() 会把 '' 转成 0,而不是走 default。
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const numericOption = (options: {
  minimum: number
  maximum: number
  defaultValue: number
  label: string
}) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: `${options.label} 必须是数字` })
      .int({ error: `${options.label} 必须是整数` })
      .min(options.minimum, { error: `${options.label} 不能小于 ${options.minimum}` })
      .max(options.maximum, { error: `${options.label} 不能大于 ${options.maximum}` })
      .default(options.defaultValue),
  )

// 布尔型环境变量:接受 1/0、true/false、yes/no
const booleanOption = (defaultValue: boolean, label: string) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return undefined
      if (typeof value === 'boolean') return value
      const normalized = String(value).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false
      return value
    },
    z.boolean({ error: `${label} 必须是布尔值(1/0、true/false、yes/no)` }).default(defaultValue),
  )

// 配置 schema。字段名用大驼峰,映射到 GRASSAGENT_ 前缀的小写下划线环境变量。
export const configSchema = z.object({
  ApiKey: z.string().min(1, { error: 'API Key 不能为空' }),
  Model: z.string().min(1, { error: '模型名不能为空' }).default('gpt-4o-mini'),
  BaseUrl: z.url({ error: 'API 地址必须是合法 URL' }).default('https://api.openai.com/v1'),
  MaxTokens: numericOption({ minimum: 1, maximum: 1_000_000, defaultValue: 4096, label: 'MaxTokens' }),

  // 工作目录沙箱:所有文件读写和命令执行都限制在这个目录内
  Workspace: z.string().min(1, { error: 'Workspace 不能为空' }).default(() => process.cwd()),

  // 重试策略:只对可重试错误(网络抖动、429、5xx)生效
  MaxRetries: numericOption({ minimum: 0, maximum: 10, defaultValue: 3, label: 'MaxRetries' }),
  RetryBaseDelayMs: numericOption({ minimum: 100, maximum: 60_000, defaultValue: 1000, label: 'RetryBaseDelayMs' }),
  RetryMaxDelayMs: numericOption({ minimum: 1000, maximum: 300_000, defaultValue: 30_000, label: 'RetryMaxDelayMs' }),

  // 并发闸门:同一时刻最多多少个 LLM 请求在飞
  MaxConcurrency: numericOption({ minimum: 1, maximum: 64, defaultValue: 4, label: 'MaxConcurrency' }),

  // 请求超时(毫秒),超时按可重试错误处理
  RequestTimeoutMs: numericOption({ minimum: 1000, maximum: 600_000, defaultValue: 120_000, label: 'RequestTimeoutMs' }),

  // 日志级别与格式
  LogLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'], {
    error: 'LogLevel 只能是 fatal/error/warn/info/debug/trace',
  }).default('info'),
  LogFormat: z.enum(['json', 'pretty'], {
    error: 'LogFormat 只能是 json 或 pretty',
  }).default('json'),

  // 会话存储。SQLite 数据库文件,多个进程可以同时读写同一个文件,
  // 各自的会话用 sessionId 隔离。
  SessionDatabasePath: z.string().min(1, { error: 'SessionDatabasePath 不能为空' })
    .default(() => path.join(os.homedir(), '.grassagent', 'sessions.db')),
  // 会话 ID。留空则每次启动自动生成,相当于开一个新会话。
  SessionId: z.string().min(1, { error: 'SessionId 不能为空' }).optional(),

  // run_bash 的命令超时。编译、跑测试这类任务通常要超过默认的 3 秒
  CommandTimeoutMs: numericOption({
    minimum: 100, maximum: 600_000, defaultValue: 3000, label: 'CommandTimeoutMs',
  }),

  // 工具执行方式。parallel 会并发跑独立的工具,同一文件的写操作仍串行。
  ToolExecution: z.enum(['parallel', 'sequential'], {
    error: 'ToolExecution 只能是 parallel 或 sequential',
  }).default('parallel'),
})

export type AgentConfig = z.infer<typeof configSchema>

// 配置校验失败时抛这个错误,CLI 捕获后打印可读提示而不是堆栈
export class ConfigError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

// 环境变量名 -> schema 字段名
const FIELD_TO_ENV_NAME: Record<keyof AgentConfig, string> = {
  ApiKey: `${ENV_PREFIX}API_KEY`,
  Model: `${ENV_PREFIX}MODEL`,
  BaseUrl: `${ENV_PREFIX}BASE_URL`,
  MaxTokens: `${ENV_PREFIX}MAX_TOKENS`,
  Workspace: `${ENV_PREFIX}WORKSPACE`,
  MaxRetries: `${ENV_PREFIX}MAX_RETRIES`,
  RetryBaseDelayMs: `${ENV_PREFIX}RETRY_BASE_DELAY_MS`,
  RetryMaxDelayMs: `${ENV_PREFIX}RETRY_MAX_DELAY_MS`,
  MaxConcurrency: `${ENV_PREFIX}MAX_CONCURRENCY`,
  RequestTimeoutMs: `${ENV_PREFIX}REQUEST_TIMEOUT_MS`,
  LogLevel: `${ENV_PREFIX}LOG_LEVEL`,
  LogFormat: `${ENV_PREFIX}LOG_FORMAT`,
  SessionDatabasePath: `${ENV_PREFIX}SESSION_DATABASE_PATH`,
  SessionId: `${ENV_PREFIX}SESSION_ID`,
  CommandTimeoutMs: `${ENV_PREFIX}COMMAND_TIMEOUT_MS`,
  ToolExecution: `${ENV_PREFIX}TOOL_EXECUTION`,
}

// .env 解析:逐行 KEY=VALUE,支持 # 注释和成对引号包裹。
// 只返回 .env 里的键值,不写入 process.env —— 合并优先级由调用方决定。
export async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 文件不存在是正常情况(用户可能全用系统环境变量),其余错误要报出来
    if (code === 'ENOENT') return {}
    throw new ConfigError(`读取 ${filePath} 失败: ${(error as Error).message}`)
  }

  const parsed: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) continue
    const name = line.slice(0, separatorIndex).trim()
    let value = line.slice(separatorIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    parsed[name] = value
  }
  return parsed
}

// 项目根目录下的 .env 路径
export function defaultEnvFilePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
}

// 把环境变量来源拍平成一个对象:系统环境变量优先于 .env。
// 原因:系统环境变量是运行时的显式指定,应当覆盖文件里的静态配置。
export function collectEnvValues(
  fileValues: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [field, envName] of Object.entries(FIELD_TO_ENV_NAME)) {
    const fromEnvironment = environment[envName]
    const fromFile = fileValues[envName]
    const chosen = fromEnvironment !== undefined && fromEnvironment !== ''
      ? fromEnvironment
      : fromFile
    if (chosen !== undefined) values[field] = chosen
  }
  return values
}

// 校验并返回配置。校验失败抛 ConfigError,附带每个字段的具体问题。
export function validateConfig(values: Record<string, unknown>): AgentConfig {
  const result = configSchema.safeParse(values)
  if (result.success) return result.data

  const issues = result.error.issues.map((issue) => {
    const field = issue.path.join('.')
    const envName = FIELD_TO_ENV_NAME[field as keyof AgentConfig] ?? field
    return `  ${envName}: ${issue.message}`
  })
  throw new ConfigError('配置校验失败:', issues)
}

// 完整加载流程:读 .env → 合并环境变量 → 校验。
export async function loadConfig(options: {
  envFilePath?: string
  environment?: NodeJS.ProcessEnv
} = {}): Promise<AgentConfig> {
  const envFilePath = options.envFilePath ?? defaultEnvFilePath()
  const fileValues = await parseEnvFile(envFilePath)
  const values = collectEnvValues(fileValues, options.environment ?? process.env)
  return validateConfig(values)
}
