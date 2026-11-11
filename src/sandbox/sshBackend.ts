// src/sandbox/sshBackend.ts
// 通过 SSH 连到远程主机,在那边起 daemon,再开隧道把调用转过去。
//
// 和 Docker 后端的差别只在「东西在哪」:
// Docker 后端把 daemon 装进容器,这个后端把它装到远程机器上。
// 对控制面来说接口一样——创建、转发、销毁。

import type { Logger } from '../core/logger.ts'
import type { ProvisionRequest, RunningSandbox, SandboxBackend } from './backend.ts'
import { deployRemoteDaemon, sweepOrphanDirectories, type RemoteDaemon } from './sshDeploy.ts'
import { resolveSshConfig, type SshConnectionConfig } from './sshConfig.ts'
import { connectSsh, openSshTunnel, type SshTunnel } from './sshTunnel.ts'
import {
  SANDBOX_PROTOCOL_VERSION,
  type SandboxCall,
  type SandboxResult,
} from './protocol.ts'

export type SshBackendOptions = {
  host: string
  port?: number
  username: string
  privateKeyPath?: string
  privateKeyPassphrase?: string
  /** ssh-agent 的 socket 或命名管道。留空则自动探测。 */
  agentPath?: string
  /** 密码认证的口令。 */
  password?: string
  knownHostsPath?: string
  /** 远程工作区的真实路径。模型看到的是 /workspace。 */
  remoteWorkspace?: string
  /** 远程上放 daemon 源码的根目录。默认 /tmp。 */
  remoteRoot?: string
  /** 等 daemon 健康的超时(毫秒)。 */
  healthTimeoutMs?: number
  /** 单次调用的超时(毫秒)。exec 按它自己的超时另算。 */
  callTimeoutMs?: number
  /** 残留目录至少这么旧才清理。太新可能在别的进程部署中。 */
  orphanMinimumAgeMs?: number
  /** keep 的沙盒目录保留这么久。 */
  keepRetentionMs?: number
  timeoutMs?: number
  logger?: Logger
}

/** 健康检查固定 3 秒:它只是确认端口接得住请求,不该等太久。 */
const HEALTH_CALL_TIMEOUT_MS = 3_000

/** 等 daemon 健康的总时长。 */
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000

/** 普通调用的超时。exec 另外按它自己的 timeoutMs 放宽。 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000

/** 残留目录的默认清理门槛:半小时。 */
const DEFAULT_ORPHAN_MINIMUM_AGE_MS = 30 * 60 * 1000

/** 远程根目录的默认值,和 deployRemoteDaemon 保持一致。 */
const DEFAULT_REMOTE_ROOT = '/tmp'

/** keep 的目录默认保留一周。 */
const DEFAULT_KEEP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** exec 在本机这一侧要留出往返和排队的时间。 */
const EXEC_TIMEOUT_MARGIN_MS = 5_000
const EXEC_TIMEOUT_CEILING_MS = 600_000

/**
 * 创建 SSH 后端。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createSshBackend(options: SshBackendOptions): SandboxBackend {
  return {
    provision: (request) => provision(options, request),
    attach: (sandboxId) => attach(options, sandboxId),
  }
}

/**
 * 连上远程,起 daemon,开隧道。
 *
 * 失败时把已经起来的部分清掉——不留半截 daemon 在远程跑着。
 */
async function provision(
  options: SshBackendOptions,
  request: ProvisionRequest,
): Promise<RunningSandbox> {
  const config = buildConfig(options)
  const client = await connectSsh(config, { logger: options.logger })
  let daemon: RemoteDaemon | undefined
  let tunnel: SshTunnel | undefined
  try {
    // 先把上次异常退出留下的目录清一遍。多会话共用一台机器时,
    // 判断是否会误删在 shouldRemoveOrphan 里,这里只管调用。
    await sweepOrphanDirectories({
      client,
      remoteRoot: options.remoteRoot ?? DEFAULT_REMOTE_ROOT,
      minimumAgeMs: options.orphanMinimumAgeMs ?? DEFAULT_ORPHAN_MINIMUM_AGE_MS,
      keepRetentionMs: options.keepRetentionMs ?? DEFAULT_KEEP_RETENTION_MS,
      logger: options.logger,
    })

    daemon = await deployRemoteDaemon({
      client,
      sandboxId: request.sandboxId,
      token: request.token,
      remoteWorkspace: config.remoteWorkspace ?? undefined,
      diskMb: request.diskMb,
      keep: request.keep,
      remoteRoot: options.remoteRoot,
      logger: options.logger,
    })
    tunnel = await openSshTunnel(client, {
      dstHost: '127.0.0.1',
      dstPort: daemon.port,
      logger: options.logger,
    })
    // 走一遍协议,确认远程 daemon 起来了、版本也对得上。
    await waitForHealthy({
      localPort: tunnel.localPort,
      token: request.token,
      daemon,
      timeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      logger: options.logger,
    })
    return runningFrom(client, daemon, tunnel, request, options)
  } catch (error) {
    // 清理已经起来的部分。顺序反过来:先断隧道,再停 daemon,最后断连接。
    if (tunnel) await tunnel.close().catch(() => undefined)
    if (daemon) await daemon.stop().catch(() => undefined)
    client.end()
    throw error
  }
}

/**
 * 挂回一个 keep 留下的沙盒。
 *
 * SSH 后端不保留远程的卷——远程目录跟着 daemon 一起被删了。
 * 所以这里直接返回 null,让控制面报「挂不回」而不是给一个空工作区。
 */
async function attach(
  options: SshBackendOptions,
  sandboxId: string,
): Promise<RunningSandbox | null> {
  options.logger?.info({ sandboxId }, 'SSH 后端不支持挂回,远程目录已随 daemon 一起删除')
  return null
}

function runningFrom(
  client: Awaited<ReturnType<typeof connectSsh>>,
  daemon: RemoteDaemon,
  tunnel: SshTunnel,
  request: ProvisionRequest,
  options: SshBackendOptions,
): RunningSandbox {
  const baseTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  return {
    sandboxId: request.sandboxId,
    // 模型看到的根固定是 /workspace,真实路径在远程那一侧。
    workspaceRoot: '/workspace',
    token: request.token,
    localWorkspace: daemon.remoteDirectory,
    keep: request.keep,
    forward: (call) => postCall(
      tunnel.localPort,
      request.token,
      call,
      callTimeoutMs(call, baseTimeoutMs),
    ),
    destroy: async ({ removeVolume }) => {
      await tunnel.close().catch(() => undefined)
      await daemon.stop().catch(() => undefined)
      client.end()
      // SSH 后端没有本地卷。远程目录由 daemon.stop 清掉。
      void removeVolume
    },
  }
}

/** exec 的超时管的是远程那条命令,本机这一侧要留出往返和排队的时间。 */
function callTimeoutMs(call: SandboxCall, baseTimeoutMs: number): number {
  if (call.kind !== 'exec') return baseTimeoutMs
  return Math.min((call.timeoutMs ?? 3_000) + EXEC_TIMEOUT_MARGIN_MS, EXEC_TIMEOUT_CEILING_MS)
}

/**
 * 等远程 daemon 健康。
 *
 * 走隧道探,和真实调用走同一条路——这样「能探通」就等于「能干活」。
 * 端口已经从日志里读到了,正常情况第一次就成功;重试是给
 * 「端口刚绑上、请求还没接住」留一点余量。
 */
async function waitForHealthy(options: {
  localPort: number
  token: string
  daemon: RemoteDaemon
  timeoutMs: number
  logger?: Logger
}): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  let lastError = '探活超时'
  while (Date.now() < deadline) {
    const health = await postCall(options.localPort, options.token, {
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'health',
    }, HEALTH_CALL_TIMEOUT_MS)
    if (health.ok && health.version === SANDBOX_PROTOCOL_VERSION) return
    lastError = health.ok ? `远端协议版本 ${health.version}` : `${health.code}: ${health.error}`
    // 版本对不上重试也没用,是两边代码不一样
    if (!health.ok && health.code === 'version') break
    await delay(300)
  }
  // 健康检查在隧道这一侧,拿不到远程日志。拼进来才好排查。
  const logTail = await options.daemon.readLogTail().catch(() => '')
  throw new Error(
    `远程 daemon 健康检查失败: ${lastError}${logTail.trim() ? `; daemon.log 尾部: ${logTail.trim()}` : ''}`,
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 通过隧道把一次调用送到远程 daemon。
 *
 * 隧道断了就是沙盒不可用,不退回本机。
 */
async function postCall(
  localPort: number,
  token: string,
  call: SandboxCall,
  timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
): Promise<SandboxResult> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${localPort}/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(call),
      // 隧道半死不活时 fetch 会一直挂着,工具调用就再也回不来了。
      // 超时统一变成 unavailable,交给上层判断是不是要重连。
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return { ok: false, code: 'unavailable', error: 'sandbox unavailable' }
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    return { ok: false, code: 'unavailable', error: 'sandbox unavailable' }
  }
  try {
    return JSON.parse(text) as SandboxResult
  } catch {
    return { ok: false, code: 'failed', error: 'daemon 返回的不是 JSON' }
  }
}

function buildConfig(options: SshBackendOptions): SshConnectionConfig {
  return resolveSshConfig({
    host: options.host,
    port: options.port,
    username: options.username,
    privateKeyPath: options.privateKeyPath,
    privateKeyPassphrase: options.privateKeyPassphrase,
    agentPath: options.agentPath,
    password: options.password,
    knownHostsPath: options.knownHostsPath,
    remoteWorkspace: options.remoteWorkspace,
    timeoutMs: options.timeoutMs,
  })
}
