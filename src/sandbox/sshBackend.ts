// src/sandbox/sshBackend.ts
// 通过 SSH 连到远程主机,在那边起 daemon,再开隧道把调用转过去。
//
// 和 Docker 后端的差别只在「东西在哪」:
// Docker 后端把 daemon 装进容器,这个后端把它装到远程机器上。
// 对控制面来说接口一样——创建、转发、销毁。

import type { Logger } from '../core/logger.ts'
import type { ProvisionRequest, RunningSandbox, SandboxBackend } from './backend.ts'
import {
  deployRemoteDaemon,
  pidIsAlive,
  readSandboxRecord,
  remotePathExists,
  runRemote,
  shellQuote,
  sweepOrphanDirectories,
  type RemoteDaemon,
  type SandboxRecord,
} from './sshDeploy.ts'
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
  /** 断线后每轮最多重连几次。0 表示关掉重连。 */
  reconnectAttempts?: number
  /** 连续几轮都救不回来,冷却这么久再试。 */
  reconnectCooldownMs?: number
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

/** 断线后每轮默认重连 3 次。 */
const DEFAULT_RECONNECT_ATTEMPTS = 3

/** 重连退避:第一次就要立刻再试,所以从第二次开始等。 */
const RECONNECT_BACKOFF_MS = [500, 2_000, 5_000] as const

/** 连续这么多轮都救不回来就冷却。 */
const RECONNECT_FAILED_EPISODES_BEFORE_COOLDOWN = 3

/** 冷却时长。期间调用直接返回不可用,不再卡在重连上。 */
const DEFAULT_RECONNECT_COOLDOWN_MS = 30_000

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
  request.onProgress?.({ phase: 'connect', message: '连接远程主机' })
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
      onProgress: request.onProgress,
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
      onProgress: request.onProgress,
      logger: options.logger,
    })
    tunnel = await openSshTunnel(client, {
      dstHost: '127.0.0.1',
      dstPort: daemon.port,
      logger: options.logger,
    })
    // 走一遍协议,确认远程 daemon 起来了、版本也对得上。
    request.onProgress?.({ phase: 'health', message: '等待远程 daemon 就绪' })
    await waitForHealthy({
      localPort: tunnel.localPort,
      token: request.token,
      daemon,
      timeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      logger: options.logger,
    })
    return runningFrom({
      client,
      tunnel,
      daemon,
      sandboxId: request.sandboxId,
      token: request.token,
      keep: request.keep,
      options,
      config,
    })
  } catch (error) {
    // 清理已经起来的部分。顺序反过来:先断隧道,再停 daemon,最后断连接。
    if (tunnel) await tunnel.close().catch(() => undefined)
    if (daemon) await daemon.stop().catch(() => undefined)
    client.end()
    throw error
  }
}

/**
 * 挂回一个之前留下的沙盒。
 *
 * 两种情况:
 * - daemon 还活着:重开隧道接上去,工作区原样
 * - daemon 已经死了:沿用保存的令牌和目录重新起一个,工作区内容不动
 *
 * 拿不到状态、工作区被删、进程在但不响应,一律返回 null。
 * 宁可说「挂不回去」,也不要给一个空工作区冒充原来的。
 */
async function attach(
  options: SshBackendOptions,
  sandboxId: string,
): Promise<RunningSandbox | null> {
  const config = buildConfig(options)
  const client = await connectSsh(config, { logger: options.logger })
  let tunnel: SshTunnel | undefined
  try {
    const record = await readSandboxRecord({
      client,
      sandboxId,
      remoteRoot: options.remoteRoot,
      logger: options.logger,
    })
    if (!record) {
      options.logger?.info({ sandboxId }, '远程没有这个沙盒的记录,不能挂回')
      client.end()
      return null
    }
    if (!await remotePathExists(client, record.state.workspace, options.logger)) {
      options.logger?.info({
        sandboxId,
        workspace: record.state.workspace,
      }, '沙盒工作区不在了,不能挂回')
      client.end()
      return null
    }

    // 进程还在就直接接上去。这里绝不能再起一个——
    // 同一个工作区跑两个 daemon,写文件会互相踩。
    if (record.state.pid > 0 && await pidIsAlive(client, record.state.pid, options.logger)) {
      tunnel = await openSshTunnel(client, {
        dstHost: '127.0.0.1',
        dstPort: record.state.port,
        logger: options.logger,
      })
      if (!await healthOnce(tunnel.localPort, record.token)) {
        await tunnel.close().catch(() => undefined)
        options.logger?.warn({
          sandboxId,
          pid: record.state.pid,
        }, '沙盒进程还在但不响应,不重复启动')
        client.end()
        return null
      }
      options.logger?.info({ sandboxId, port: record.state.port }, '沙盒已挂回')
      return runningFrom({
        client,
        tunnel,
        daemon: daemonHandleFromRecord(client, record, options.logger),
        sandboxId,
        token: record.token,
        // 挂回来的按 keep 处理,否则控制面回收时会把持久化状态删掉
        keep: true,
        options,
        config,
      })
    }

    // 进程已经死了:沿用原来的目录和令牌重新起一个,工作区不动
    const daemon = await deployRemoteDaemon({
      client,
      sandboxId,
      token: record.token,
      remoteWorkspace: record.state.workspace,
      diskMb: record.state.diskMb,
      keep: true,
      remoteRoot: options.remoteRoot,
      logger: options.logger,
    })
    tunnel = await openSshTunnel(client, {
      dstHost: '127.0.0.1',
      dstPort: daemon.port,
      logger: options.logger,
    })
    await waitForHealthy({
      localPort: tunnel.localPort,
      token: record.token,
      daemon,
      timeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      logger: options.logger,
    })
    options.logger?.info({ sandboxId, port: daemon.port }, '沙盒已重新拉起')
    return runningFrom({
      client,
      tunnel,
      daemon,
      sandboxId,
      token: record.token,
      keep: true,
      options,
      config,
    })
  } catch (error) {
    await tunnel?.close().catch(() => undefined)
    client.end()
    throw error
  }
}

/** 用持久化记录拼一个 daemon 句柄。日志和清理脚本都在沙盒目录里。 */
function daemonHandleFromRecord(
  client: Awaited<ReturnType<typeof connectSsh>>,
  record: SandboxRecord,
  logger?: Logger,
): RemoteDaemon {
  const logPath = `${record.sandboxDir}/daemon.log`
  const stopScriptPath = `${record.sandboxDir}/stop.sh`
  const killCommand = `sh ${shellQuote(stopScriptPath)} ${shellQuote(record.sandboxDir)}`
  return {
    port: record.state.port,
    remoteDirectory: record.sandboxDir,
    sourceDirectory: record.state.sourceDirectory,
    readLogTail: async (maxChars = 800) => {
      const output = await runRemote(client, `cat ${shellQuote(logPath)} 2>/dev/null || true`, logger)
      return output.slice(-maxChars)
    },
    stopProcess: async () => {
      await runRemote(client, killCommand, logger).catch(() => undefined)
    },
    stop: async () => {
      await runRemote(
        client,
        `${killCommand}; rm -rf ${shellQuote(record.sandboxDir)}`,
        logger,
      ).catch(() => undefined)
    },
  }
}

function runningFrom(params: {
  client: Awaited<ReturnType<typeof connectSsh>>
  tunnel: SshTunnel
  daemon: RemoteDaemon
  sandboxId: string
  token: string
  keep: boolean
  options: SshBackendOptions
  config: SshConnectionConfig
}): RunningSandbox {
  const baseTimeoutMs = params.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const session = new SshSession(params)

  return {
    sandboxId: params.sandboxId,
    // 模型看到的根固定是 /workspace,真实路径在远程那一侧。
    workspaceRoot: '/workspace',
    token: params.token,
    localWorkspace: params.daemon.remoteDirectory,
    keep: params.keep,
    forward: (call) => session.forward(call, baseTimeoutMs),
    destroy: async ({ removeVolume }) => {
      session.markClosed()
      await session.closeTunnel()
      // keep 的时候只停进程,目录留着给下次挂回
      if (removeVolume) await params.daemon.stop()
      else await params.daemon.stopProcess()
      session.closeClient()
    },
  }
}

/**
 * 一个会话的 SSH 连接和隧道。
 *
 * 断线后惰性重连:只有调用真的失败了才重连,不做后台心跳。
 * 每轮最多试 N 次、连续几轮都失败就冷却一段时间,避免每次工具调用
 * 都卡在重连上。
 */
class SshSession {
  private client: Awaited<ReturnType<typeof connectSsh>>
  private tunnel: SshTunnel
  private readonly params: Parameters<typeof runningFrom>[0]
  private closed = false
  private failedEpisodes = 0
  private deadUntil = 0
  private reconnecting: Promise<boolean> | undefined

  constructor(params: Parameters<typeof runningFrom>[0]) {
    this.params = params
    this.client = params.client
    this.tunnel = params.tunnel
  }

  /** 转发一次调用。传输层失败时先尝试重连,再接一次。 */
  async forward(call: SandboxCall, baseTimeoutMs: number): Promise<SandboxResult> {
    const timeoutMs = callTimeoutMs(call, baseTimeoutMs)
    const result = await postCall(this.tunnel.localPort, this.params.token, call, timeoutMs)
    // 业务错误(路径越界、版本不符)重连也没用
    if (result.ok || result.code !== 'unavailable') return result
    if (!(await this.reconnect())) return result
    return postCall(this.tunnel.localPort, this.params.token, call, timeoutMs)
  }

  markClosed(): void {
    this.closed = true
  }

  async closeTunnel(): Promise<void> {
    await this.tunnel.close().catch(() => undefined)
  }

  closeClient(): void {
    this.client.end()
  }

  private async reconnect(): Promise<boolean> {
    const { options, config } = this.params
    const attempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS
    if (this.closed || attempts <= 0) return false
    if (Date.now() < this.deadUntil) return false
    if (this.reconnecting) return this.reconnecting

    this.reconnecting = (async () => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await delay(RECONNECT_BACKOFF_MS[attempt - 1] ?? 5_000)
        let nextClient: Awaited<ReturnType<typeof connectSsh>> | undefined
        let nextTunnel: SshTunnel | undefined
        try {
          nextClient = await connectSsh(config, { logger: options.logger })
          nextTunnel = await openSshTunnel(nextClient, {
            dstHost: '127.0.0.1',
            dstPort: this.params.daemon.port,
            logger: options.logger,
          })
          // 隧道通了不代表 daemon 还在,再探一次
          if (!await healthOnce(nextTunnel.localPort, this.params.token)) {
            await nextTunnel.close().catch(() => undefined)
            nextClient.end()
            continue
          }
          await this.tunnel.close().catch(() => undefined)
          this.client.end()
          this.client = nextClient
          this.tunnel = nextTunnel
          this.failedEpisodes = 0
          options.logger?.info({ sandboxId: this.params.sandboxId }, 'SSH 连接已重连')
          return true
        } catch (error) {
          await nextTunnel?.close().catch(() => undefined)
          nextClient?.end()
          options.logger?.warn({
            attempt: attempt + 1,
            errorMessage: (error as Error).message,
          }, 'SSH 重连失败')
        }
      }
      this.failedEpisodes++
      // 连续几轮都救不回来就别再试了,冷却一段时间直接返回不可用
      if (this.failedEpisodes >= RECONNECT_FAILED_EPISODES_BEFORE_COOLDOWN) {
        this.deadUntil = Date.now() + (options.reconnectCooldownMs ?? DEFAULT_RECONNECT_COOLDOWN_MS)
      }
      return false
    })()

    try {
      return await this.reconnecting
    } finally {
      this.reconnecting = undefined
    }
  }
}

/** 探一次健康。返回 true 表示 daemon 在正常应答。 */
async function healthOnce(localPort: number, token: string): Promise<boolean> {
  const health = await postCall(localPort, token, {
    version: SANDBOX_PROTOCOL_VERSION,
    kind: 'health',
  }, HEALTH_CALL_TIMEOUT_MS)
  return health.ok && health.version === SANDBOX_PROTOCOL_VERSION
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
