// src/sandbox/secrets.ts
// 凭据只通过 0600 文件进入控制面。请求体、进程参数和日志里不放值。

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { parseJson } from '../core/jsonSafety.ts'

const SECRET_NAME = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * 环境变量名里带密钥字样的项不进容器。作者：Pieory 创建日期：2025-07-18
 */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name)
}

/**
 * 容器只拿运行命令真正需要的环境,并且再滤一遍密钥名字。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function sandboxProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SYSTEMROOT', 'PATHEXT']
  const env: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    if (source[key] === undefined) continue
    if (isSecretEnvName(key)) continue
    env[key] = source[key]
  }
  return env
}

/**
 * 写完再 chmod。umask 会让 writeFile 的 mode 比 0600 更宽,单靠 mode 参数不够。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function writeSecretFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 })
  await chmod(filePath, 0o600)
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function createToken(): string {
  return randomBytes(32).toString('hex')
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function createSandboxId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 按引用取凭据。文件权限不是 0600 就拒绝,避免组可读的密钥被沙盒用户看见。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function resolveCredentialRef(
  ref: string | undefined,
  filePath: string | undefined,
): Promise<string | null> {
  if (!ref) return null
  if (!filePath) throw new Error('credentialRef 无法解析:没有凭据文件')
  const info = await stat(filePath)
  if ((info.mode & 0o077) !== 0) {
    throw new Error('凭据文件权限必须是 0600')
  }
  const parsed = parseJson(await readFile(filePath, 'utf-8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('凭据文件必须是 JSON 对象')
  }
  const value = (parsed as Record<string, unknown>)[ref]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`credentialRef 不存在: ${ref}`)
  }
  return value
}
