// src/sandbox/remoteLayout.ts
// 远程目录布局,以及几个能单独测的纯函数。
//
// 分成两类目录,因为生命周期不一样:
// - 共享源码目录按内容 hash 命名,同一台机器上所有会话共用一份,不随单次会话删除
// - 每沙盒目录放令牌、PID、日志、state,会话结束就该消失
//
// 混在一起的话,要么删不干净,要么把别人正在用的源码一起删了。

import { createHash } from 'node:crypto'
import { parseJson } from '../core/jsonSafety.ts'
import { SANDBOX_PROTOCOL_VERSION } from './protocol.ts'

/** 共享源码目录的前缀。 */
export const SOURCE_DIRECTORY_PREFIX = 'grass-daemon-'

/** 每沙盒目录的前缀。 */
export const SANDBOX_DIRECTORY_PREFIX = 'grass-sandbox-'

/** 上传中的临时目录标记。 */
export const STAGING_MARKER = '.tmp-'

/**
 * 布局版本。目录结构改了就要加一,否则旧目录里那套文件会被当成还能用。
 */
export const SOURCE_LAYOUT_VERSION = 1

/** daemon 需要 Node 24.3+,type stripping 从那个版本起默认开启。 */
export const MINIMUM_NODE_VERSION = { major: 24, minor: 3, patch: 0 } as const

export type NodeVersion = { major: number; minor: number; patch: number }

/** 共享源码目录。名字由内容 hash 决定,内容一样就不用重传。 */
export function sourceDirectory(remoteRoot: string, shortHash: string): string {
  return `${trimSlash(remoteRoot)}/${SOURCE_DIRECTORY_PREFIX}${shortHash}`
}

/** 每沙盒目录。令牌、PID、日志、state 都在这。 */
export function sandboxDirectory(remoteRoot: string, sandboxId: string): string {
  return `${trimSlash(remoteRoot)}/${SANDBOX_DIRECTORY_PREFIX}${sandboxId}`
}

/** 上传中的临时目录。带上进程和随机数,两个进程同时部署不会互相踩。 */
export function stagingDirectory(sourceDir: string, nonce: string): string {
  return `${sourceDir}${STAGING_MARKER}${process.pid}-${nonce}`
}

/**
 * 源码内容 hash。
 *
 * 把布局版本和协议版本也算进去:协议变了,旧目录里的 daemon 就不能再用,
 * 哪怕源码文件一个字没改。
 */
export function computeSourceHash(
  sources: ReadonlyMap<string, string>,
): { shortHash: string; fullHash: string } {
  const hash = createHash('sha256')
  hash.update(`layout:${SOURCE_LAYOUT_VERSION}\n`)
  hash.update(`protocol:${SANDBOX_PROTOCOL_VERSION}\n`)
  // 排序后再算,hash 才和文件系统的遍历顺序无关
  for (const relative of [...sources.keys()].sort()) {
    hash.update(relative)
    hash.update('\0')
    hash.update(sources.get(relative) ?? '')
    hash.update('\0')
  }
  const fullHash = hash.digest('hex')
  return { shortHash: fullHash.slice(0, 16), fullHash }
}

/** 解析 `node --version` 的输出。解析不了返回 null。 */
export function parseNodeVersion(output: string): NodeVersion | null {
  const matched = output.trim().match(/^v(\d+)\.(\d+)\.(\d+)/)
  if (!matched) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
  }
}

/** 这个 Node 版本够不够跑 daemon。 */
export function nodeVersionIsSupported(version: NodeVersion): boolean {
  const minimum = MINIMUM_NODE_VERSION
  if (version.major !== minimum.major) return version.major > minimum.major
  return version.minor >= minimum.minor
}

export function formatNodeVersion(version: NodeVersion): string {
  return `v${version.major}.${version.minor}.${version.patch}`
}

/**
 * 没配远程工作区时的默认路径。
 *
 * 用用户自己的 HOME,不用 /workspace:那个路径通常要 root 才能建,
 * 也不该往 /tmp 里放——systemd 的 tmpfiles 会定期清理,
 * 用户的代码跟着一起没。
 */
export function homeWorkspace(homeDirectory: string): string {
  return `${trimSlash(homeDirectory)}/grass-workspace`
}

/** 每沙盒目录里的状态文件。挂回和孤儿扫描都读它。 */
export const SANDBOX_STATE_FILE_NAME = 'state.json'

/**
 * 一个沙盒的持久化状态。
 *
 * 进程崩了之后,这些是唯一能说明「这个目录属于谁、还活不活」的东西。
 */
export type SandboxState = {
  schema: 1
  sandboxId: string
  workspace: string
  sourceHash: string
  sourceDirectory: string
  port: number
  pid: number
  diskMb: number
  protocolVersion: number
  keep: boolean
  createdAt: string
  keptAt?: string
}

/** 解析 state.json。结构对不上就当没有——模型和用户都能改这个文件。 */
export function parseSandboxState(text: string): SandboxState | null {
  let parsed: unknown
  try {
    parsed = parseJson(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const state = parsed as Record<string, unknown>
  if (state.schema !== 1) return null
  if (typeof state.sandboxId !== 'string') return null
  if (typeof state.workspace !== 'string') return null
  if (typeof state.sourceDirectory !== 'string') return null
  if (typeof state.port !== 'number') return null
  return {
    schema: 1,
    sandboxId: state.sandboxId,
    workspace: state.workspace,
    sourceHash: typeof state.sourceHash === 'string' ? state.sourceHash : '',
    sourceDirectory: state.sourceDirectory,
    port: state.port,
    pid: typeof state.pid === 'number' ? state.pid : 0,
    diskMb: typeof state.diskMb === 'number' ? state.diskMb : 10_240,
    protocolVersion: typeof state.protocolVersion === 'number' ? state.protocolVersion : 0,
    keep: state.keep === true,
    createdAt: typeof state.createdAt === 'string' ? state.createdAt : '',
    keptAt: typeof state.keptAt === 'string' ? state.keptAt : undefined,
  }
}

/** 扫描用的一个沙盒目录候选。 */
export type OrphanCandidate = {
  directory: string
  /** 目录最后修改到现在过了多久。 */
  ageMs: number
  /** state.json 读不出来的目录,绝不自动删。 */
  stateReadable: boolean
  keep: boolean
  /** keep 之后过了多久。没 keep 过就是 undefined。 */
  keptAgeMs?: number
  pidAlive: boolean
}

export type OrphanPolicy = {
  /** 目录至少这么旧才考虑删。太新可能在别的进程部署中。 */
  minimumAgeMs: number
  /** keep 的目录保留这么久。 */
  keepRetentionMs: number
}

/**
 * 该不该删这个目录。
 *
 * 多会话共存时,唯一可靠的「活跃」证据是 PID 还活着。所以判断顺序是
 * 一路放行:读不到状态、进程还活着、keep 没过期、目录太新,任一成立就先留着。
 * 宁可漏删留垃圾,也不能把别人正在用的沙盒删了。
 */
export function shouldRemoveOrphan(
  candidate: OrphanCandidate,
  policy: OrphanPolicy,
): boolean {
  if (!candidate.stateReadable) return false
  if (candidate.pidAlive) return false
  if (candidate.keep && (candidate.keptAgeMs ?? 0) < policy.keepRetentionMs) return false
  return candidate.ageMs >= policy.minimumAgeMs
}

/** 扫描输出的一行。字段用 tab 分隔,路径里有空格也不怕。 */
export type SweepLine =
  | { kind: 'sandbox'; directory: string; modifiedSeconds: number; pid: number | null; state: SandboxState | null }
  | { kind: 'staging'; directory: string; modifiedSeconds: number }

/**
 * 解析扫描命令的输出。
 *
 * 格式和 sweepListingCommand 一一对应。坏行跳过——扫描是尽力而为,
 * 一行看不懂不该让整次清理失败。
 */
export function parseSweepListing(output: string): SweepLine[] {
  const lines: SweepLine[] = []
  for (const raw of output.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const fields = trimmed.split('\t')
    const kind = fields[0]
    if (kind === 'S') {
      const directory = fields[1]
      if (!directory) continue
      const modifiedSeconds = Number(fields[2] ?? '0') || 0
      const pidText = (fields[3] ?? '').trim()
      const pid = /^\d+$/.test(pidText) ? Number(pidText) : null
      const stateText = fields[4] ?? ''
      lines.push({
        kind: 'sandbox',
        directory,
        modifiedSeconds,
        pid,
        state: stateText ? parseSandboxState(stateText) : null,
      })
      continue
    }
    if (kind === 'T') {
      const directory = fields[1]
      if (!directory) continue
      lines.push({
        kind: 'staging',
        directory,
        modifiedSeconds: Number(fields[2] ?? '0') || 0,
      })
    }
  }
  return lines
}

/**
 * 列出远程根目录下的沙盒目录和上传残留。
 *
 * 只做数据采集,删不删由 shouldRemoveOrphan 在 TypeScript 里判断——
 * 把决策塞进 shell 就没法单测了。
 */
export function sweepListingCommand(remoteRoot: string): string {
  const root = trimSlash(remoteRoot)
  return [
    `for dir in ${root}/grass-sandbox-*; do`,
    '  [ -d "$dir" ] || continue',
    '  modified="$(stat -c %Y "$dir" 2>/dev/null || stat -f %m "$dir" 2>/dev/null || echo 0)"',
    '  pid="$(cat "$dir/daemon.pid" 2>/dev/null | tr -d " \\n")"',
    '  state="$(cat "$dir/state.json" 2>/dev/null | tr -d "\\n")"',
    '  printf "S\\t%s\\t%s\\t%s\\t%s\\n" "$dir" "$modified" "$pid" "$state"',
    'done',
    `for dir in ${root}/grass-daemon-*.tmp-*; do`,
    '  [ -d "$dir" ] || continue',
    '  modified="$(stat -c %Y "$dir" 2>/dev/null || stat -f %m "$dir" 2>/dev/null || echo 0)"',
    '  printf "T\\t%s\\t%s\\n" "$dir" "$modified"',
    'done',
  ].join('\n')
}

function trimSlash(remotePath: string): string {
  return remotePath.replace(/\/+$/, '')
}