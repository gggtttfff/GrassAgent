// src/sandbox/protocol.ts
// Grass 和 daemon 之间的窄协议:读、写、编辑、执行。没有通用壳,也没有文件描述符转发。

import { timingSafeEqual } from 'node:crypto'
import {
  PolicyDeniedError,
  SandboxUnavailableError,
  type TextEdit,
} from '../world/executionWorld.ts'
import { TextEditError } from '../core/textEdit.ts'

/** 对不上就拒绝,不在半新半旧的进程上继续干活。 */
export const SANDBOX_PROTOCOL_VERSION = 2

export const MAX_CALL_BYTES = 2 * 1024 * 1024

/** raw 读的上限。技能、配置这类要全文的文件走这条,普通读取不受它管。 */
export const MAX_RAW_BYTES = 1024 * 1024

export type SandboxCall = {
  version: number
  kind: 'health' | 'read' | 'write' | 'edit' | 'exec' | 'list'
  path?: string
  content?: string
  edits?: TextEdit[]
  argv?: string[]
  cwd?: string
  timeoutMs?: number
  /** read 时要全文就带上它,不走输出上限的截断 */
  raw?: boolean
}

/** 目录里的一个条目。size 和 mtimeMs 让客户端能判断文件有没有变过。 */
export type SandboxEntry = {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
  mtimeMs?: number
}

export type SandboxSuccess = {
  ok: true
  version: number
  content?: string
  path?: string
  entries?: SandboxEntry[]
  exitCode?: number
  stdout?: string
  stderr?: string
  aborted?: boolean
  timedOut?: boolean
}

export type SandboxFailureCode =
  | 'version'
  | 'unauthorized'
  | 'unavailable'
  | 'path'
  | 'policy'
  | 'encoding'
  | 'edit'
  | 'failed'

export type SandboxFailure = {
  ok: false
  code: SandboxFailureCode
  error: string
  reason?: 'not_found' | 'not_unique'
  index?: number
  count?: number
  filePath?: string
}

export type SandboxResult = SandboxSuccess | SandboxFailure

/**
 * 令牌比较不提前返回,避免用耗时差猜长度。作者：Pieory 创建日期：2025-07-18
 */
export function tokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 把 daemon 的失败变回本地工具已经认识的错误类型。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function failureToError(failure: SandboxFailure): Error {
  if (failure.code === 'unavailable') return new SandboxUnavailableError()
  if (failure.code === 'policy') return new PolicyDeniedError(failure.error)
  if (failure.code === 'encoding') return new Error(failure.error)
  if (failure.code === 'edit' && (failure.reason === 'not_found' || failure.reason === 'not_unique')) {
    return new TextEditError({
      reason: failure.reason,
      index: failure.index ?? 0,
      count: failure.count ?? 0,
      filePath: failure.filePath ?? '',
    })
  }
  if (failure.code === 'version') return new Error(`远端协议版本不符: ${failure.error}`)
  return new Error(failure.error)
}

/**
 * 工具和日志都不该带上令牌或仓库口令。短字符串不替换,免得把普通单词擦掉。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret.length < 6) continue
    result = result.split(secret).join('[REDACTED]')
  }
  return result
}
