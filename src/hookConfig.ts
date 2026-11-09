// src/hookConfig.ts
// 钩子配置 —— 从 JSON 文件读出命令钩子。
//
// 和 .env 分开:钩子是按事件分组的结构,塞进环境变量会不可读。
// 文件可以不存在(还没配钩子是正常状态);文件存在但写错要在启动时失败,
// 不能等到第一次调工具才发现 matcher 是坏正则。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { JsonSafetyError, parseJson } from './jsonSafety.ts'
import { HOOK_EVENTS, type HookDefinition, type HookEventName } from './hooks.ts'

export class HookConfigError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = 'HookConfigError'
    this.issues = issues
  }
}

const commandHookSchema = z.object({
  type: z.literal('command', { error: '目前只支持 type=command 的钩子' }),
  command: z.string().min(1, { error: '钩子命令不能为空' }),
  timeoutMs: z.number().int({ error: 'timeoutMs 必须是整数' }).positive({ error: 'timeoutMs 必须大于 0' })
    .max(600_000, { error: 'timeoutMs 不能大于 600000' })
    .optional(),
  once: z.boolean().optional(),
}).strict()

const matcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(commandHookSchema).min(1, { error: 'matcher 下至少要有一个钩子' }),
}).strict()

const eventListSchema = z.array(matcherGroupSchema)

// 每个事件都是可选的。strict 用来拦住写错的事件名和尚未支持的字段(async、http)。
const hookFileSchema = z.object({
  SessionStart: eventListSchema.optional(),
  SessionEnd: eventListSchema.optional(),
  UserPromptSubmit: eventListSchema.optional(),
  PreToolUse: eventListSchema.optional(),
  PostToolUse: eventListSchema.optional(),
  PostToolUseFailure: eventListSchema.optional(),
  Stop: eventListSchema.optional(),
  PreCompact: eventListSchema.optional(),
}).strict()

type HookFile = z.infer<typeof hookFileSchema>

/** 默认路径:工作区下的 .grass/hooks.json。没有这个文件就等于没配钩子。 */
export function defaultHooksFilePath(workspace: string): string {
  return path.join(workspace, '.grass', 'hooks.json')
}

/**
 * 读取钩子文件。
 *
 * optional 为 true 时,文件不存在返回空列表(默认路径)。
 * 显式指定了路径还找不到,那是配置错误,要报出来。
 */
export async function loadHooksFile(filePath: string, options: { optional: boolean }): Promise<HookDefinition[]> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && options.optional) return []
    if (code === 'ENOENT') throw new HookConfigError(`找不到钩子配置 ${filePath}`)
    throw new HookConfigError(`读取钩子配置失败: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    // 超深的文件能解析成功,但后面的校验和序列化会递归爆栈。先量深度。
    parsed = parseJson(content)
  } catch (error) {
    if (error instanceof JsonSafetyError) throw new HookConfigError(`${filePath} ${error.message}`)
    throw new HookConfigError(`${filePath} 不是合法 JSON: ${(error as Error).message}`)
  }

  let body: unknown
  try {
    body = unwrapHookFile(parsed)
  } catch (error) {
    if (error instanceof HookConfigError) throw error
    throw new HookConfigError((error as Error).message)
  }

  const result = hookFileSchema.safeParse(body)
  if (!result.success) {
    throw new HookConfigError('钩子配置校验失败:', formatIssues(result.error))
  }
  return definitionsFromFile(result.data)
}

function unwrapHookFile(value: unknown): unknown {
  if (!isPlainObject(value) || !('hooks' in value)) return value
  // 顶层已经是事件名时,不再拆 hooks 字段,避免两种写法混在一起看不懂。
  if (HOOK_EVENTS.some((event) => event in value)) return value
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'hooks') {
    throw new HookConfigError('钩子配置要么直接按事件写,要么只包一层 "hooks"')
  }
  return value.hooks
}

function definitionsFromFile(file: HookFile): HookDefinition[] {
  const definitions: HookDefinition[] = []
  for (const event of HOOK_EVENTS) {
    const groups = file[event as HookEventName]
    if (!groups) continue
    for (const group of groups) {
      const matcher = compileMatcher(event, group.matcher)
      for (const hook of group.hooks) {
        definitions.push({
          event,
          matcher,
          command: hook.command,
          timeoutMs: hook.timeoutMs,
          once: hook.once,
          name: hook.command,
        })
      }
    }
  }
  return definitions
}

function compileMatcher(event: HookEventName, source: string | undefined): RegExp | undefined {
  if (!source || !source.trim()) return undefined
  try {
    return new RegExp(source)
  } catch (error) {
    throw new HookConfigError(
      `事件 ${event} 的 matcher 不是合法正则: ${source} (${(error as Error).message})`,
    )
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.join('.') || '(root)'
    return `  ${field}: ${issue.message}`
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
