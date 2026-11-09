// src/sessionBundle.ts
// 会话包 —— 把 SQLite 里的对话收成一个 JSON 文件,换一台机器再导回来。
//
// 包里只有会话。API Key、钩子命令都不进文件:
// 密钥留在原来的环境里,钩子留在项目的 .grass/hooks.json,跟仓库走。
// 包是数据,导入时不执行里面的任何文本。

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { messagesArePaired, normalizeMessage, type Message } from './messages.ts'
import type { SessionSnapshot } from './sessionStore.ts'

export const BUNDLE_FORMAT = 'grassagent-bundle'
export const BUNDLE_VERSION = 1

// 对话可能很长,但要有上限,避免一个坏文件把进程撑死。
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class BundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleError'
  }
}

export interface PortableSession {
  id: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

/** 默认落在工作区里,用户拿走这个文件就能走。 */
export function defaultBundlePath(workspace: string): string {
  return path.join(workspace, '.grass', 'grassagent-bundle.json')
}

/**
 * 用户给的路径。相对路径锚定工作区,`~` 展开到用户主目录。
 * 导入导出是用户自己的命令,目的就是把文件带出工作区,所以这里不套沙箱。
 */
export function resolveBundlePath(input: string, workspace: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(os.homedir(), trimmed.slice(2))
  }
  return path.resolve(workspace, trimmed)
}

export function parseExportArgument(argument: string): {
  filePath?: string
  sessionId?: string
  error?: string
} {
  const tokens = argument.trim().split(/\s+/).filter(Boolean)
  let filePath: string | undefined
  let sessionId: string | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--session') {
      const next = tokens[index + 1]
      if (!next || next.startsWith('--')) {
        return { error: 'export 缺少会话 ID。用法:/export [路径] [--session 会话ID]' }
      }
      sessionId = next
      index++
      continue
    }
    if (token.startsWith('--')) return { error: `export 不认识参数 ${token}` }
    if (filePath) {
      return { error: 'export 只能有一个路径。路径里不要加空格,或先导出到默认位置再移动文件。' }
    }
    filePath = token
  }
  return {
    ...(filePath ? { filePath } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
}

export function parseImportArgument(argument: string): {
  filePath?: string
  replace: boolean
  error?: string
} {
  const tokens = argument.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return { replace: false, error: 'import 需要文件路径。用法:/import <路径> [--replace]' }
  }
  let filePath: string | undefined
  let replace = false
  for (const token of tokens) {
    if (token === '--replace') {
      replace = true
      continue
    }
    if (token === '--merge') {
      replace = false
      continue
    }
    if (token.startsWith('--')) return { replace: false, error: `import 不认识参数 ${token}` }
    if (filePath) return { replace: false, error: 'import 只能有一个路径' }
    filePath = token
  }
  if (!filePath) {
    return { replace, error: 'import 需要文件路径。用法:/import <路径> [--replace]' }
  }
  return { filePath, replace }
}

export function serializeBundle(sessions: readonly SessionSnapshot[], exportedAt = new Date().toISOString()): string {
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt,
    sessions: sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
    })),
  }
  return `${JSON.stringify(bundle, null, 2)}\n`
}

export function parseBundle(text: string): PortableSession[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BundleError('文件不是合法 JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new BundleError('文件内容不是对象')
  const bundle = parsed as Record<string, unknown>
  if (bundle.format !== BUNDLE_FORMAT) throw new BundleError('不是 grassagent 会话包')
  if (bundle.version !== BUNDLE_VERSION) {
    throw new BundleError(`不支持的会话包版本 ${String(bundle.version)}`)
  }
  if (!Array.isArray(bundle.sessions)) throw new BundleError('sessions 必须是数组')

  const seen = new Set<string>()
  return bundle.sessions.map((item) => parseSession(item, seen))
}

export async function writeBundleFile(filePath: string, sessions: readonly SessionSnapshot[]): Promise<void> {
  const text = serializeBundle(sessions)
  if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) {
    throw new BundleError('会话包超过 32MB,请改用 --session 只导出一个会话')
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporary, text, 'utf8')
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

export async function readBundleFile(filePath: string): Promise<PortableSession[]> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new BundleError(`找不到文件 ${filePath}`)
    throw error
  }
  if (!stat.isFile()) throw new BundleError(`${filePath} 不是文件`)
  if (stat.size > MAX_BUNDLE_BYTES) throw new BundleError('会话包超过 32MB,已拒绝读取')
  const text = await fs.readFile(filePath, 'utf8')
  return parseBundle(text)
}

function parseSession(value: unknown, seen: Set<string>): PortableSession {
  if (!value || typeof value !== 'object') throw new BundleError('会话条目不是对象')
  const session = value as Record<string, unknown>
  if (typeof session.id !== 'string' || !SESSION_ID_PATTERN.test(session.id)) {
    throw new BundleError('会话 ID 只能包含字母、数字、点、下划线和短横线')
  }
  if (seen.has(session.id)) throw new BundleError(`会话 ID 重复:${session.id}`)
  seen.add(session.id)
  if (!isTimestamp(session.createdAt) || !isTimestamp(session.updatedAt)) {
    throw new BundleError(`会话 ${session.id} 的时间戳不合法`)
  }
  if (!Array.isArray(session.messages)) throw new BundleError(`会话 ${session.id} 的 messages 必须是数组`)

  const messages: Message[] = []
  for (const raw of session.messages) {
    const normalized = normalizeMessage(raw)
    if (!normalized) throw new BundleError(`会话 ${session.id} 里有无法识别的消息,已拒绝导入`)
    messages.push(normalized)
  }
  if (!messagesArePaired(messages)) {
    throw new BundleError(`会话 ${session.id} 的 tool_call 和 tool_result 配不上对,已拒绝导入`)
  }
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages,
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
