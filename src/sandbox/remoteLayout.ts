// src/sandbox/remoteLayout.ts
// 远程目录布局,以及几个能单独测的纯函数。
//
// 分成两类目录,因为生命周期不一样:
// - 共享源码目录按内容 hash 命名,同一台机器上所有会话共用一份,不随单次会话删除
// - 每沙盒目录放令牌、PID、日志、state,会话结束就该消失
//
// 混在一起的话,要么删不干净,要么把别人正在用的源码一起删了。

import { createHash } from 'node:crypto'
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

function trimSlash(remotePath: string): string {
  return remotePath.replace(/\/+$/, '')
}