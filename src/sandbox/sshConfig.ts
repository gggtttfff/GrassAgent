// src/sandbox/sshConfig.ts
// SSH 后端的连接参数。只在这里解析主机、用户、端口和凭据,
// 别的地方不要直接读环境变量,免得同一个键有两套解释。

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/** Windows 上 OpenSSH 自带的 agent 命名管道。 */
const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/** 一次 SSH 连接需要的全部信息。私钥、口令和密码都不进日志。 */
export type SshConnectionConfig = {
  host: string
  port: number
  username: string
  /** 私钥文件的绝对路径。空则用 ssh-agent 或密码。 */
  privateKeyPath: string | null
  privateKeyPassphrase: string | null
  /** ssh-agent 的 socket 或命名管道。空则不用 agent。 */
  agentPath: string | null
  /** 密码认证的口令。 */
  password: string | null
  /** known_hosts 的绝对路径。空则用 ~/.ssh/known_hosts。 */
  knownHostsPath: string
  /** 远程工作区的真实路径。模型看到的是 /workspace,这里对应远程的真实目录。 */
  remoteWorkspace: string
  /** 连接和握手超时(毫秒)。 */
  timeoutMs: number
}

export class SshConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshConfigError'
  }
}

export type SshConfigInput = {
  host?: string
  port?: number
  username?: string
  privateKeyPath?: string
  privateKeyPassphrase?: string
  agentPath?: string
  password?: string
  knownHostsPath?: string
  remoteWorkspace?: string
  timeoutMs?: number
}

/**
 * 把配置整理成能直接连的形状。
 *
 * 私钥路径和 known_hosts 路径都展开成绝对路径——相对路径会以
 * 进程工作目录为基准,那不是用户想指的地方。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function resolveSshConfig(input: SshConfigInput): SshConnectionConfig {
  const host = input.host?.trim()
  if (!host) throw new SshConfigError('SSH 后端缺少主机地址')
  const username = input.username?.trim()
  if (!username) throw new SshConfigError('SSH 后端缺少用户名')

  const privateKeyPath = input.privateKeyPath?.trim()
    ? path.resolve(expandHome(input.privateKeyPath.trim()))
    : null
  const knownHostsPath = input.knownHostsPath?.trim()
    ? path.resolve(expandHome(input.knownHostsPath.trim()))
    : path.join(os.homedir(), '.ssh', 'known_hosts')
  const remoteWorkspace = input.remoteWorkspace?.trim() || '/workspace'
  const agentPath = input.agentPath?.trim() || defaultAgentPath()

  return {
    host,
    port: input.port ?? 22,
    username,
    privateKeyPath,
    privateKeyPassphrase: input.privateKeyPassphrase?.trim() || null,
    agentPath,
    password: input.password?.trim() || null,
    knownHostsPath,
    remoteWorkspace,
    timeoutMs: input.timeoutMs ?? 30_000,
  }
}

/**
 * 挑一个默认的 ssh-agent 地址。
 *
 * POSIX 走 SSH_AUTH_SOCK。Windows 没有这个变量,但 OpenSSH 客户端自带的 agent
 * 监听一个固定命名管道——先确认它真在,不然 ssh2 会去连不存在的管道然后认证失败。
 */
function defaultAgentPath(): string | null {
  const fromEnvironment = process.env.SSH_AUTH_SOCK?.trim()
  if (fromEnvironment) return fromEnvironment
  if (process.platform === 'win32' && existsSync(WINDOWS_AGENT_PIPE)) return WINDOWS_AGENT_PIPE
  return null
}

/**
 * 读私钥内容。口令由 ssh2 处理,不在这层解密。
 *
 * 读不到就报错,不要退回空私钥——那会让 ssh2 变成密码认证,
 * 认证方式会在用户不知情的情况下变掉。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function readPrivateKey(privateKeyPath: string): Promise<string> {
  try {
    return await readFile(privateKeyPath, 'utf-8')
  } catch (error) {
    throw new SshConfigError(`读不到 SSH 私钥 ${privateKeyPath}: ${(error as Error).message}`)
  }
}

/**
 * 展开 ~ 前缀。ssh 的配置里习惯写 ~/.ssh/id_ed25519,
 * 直接交给 ssh2 会被当成相对路径。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2))
  return filePath
}
