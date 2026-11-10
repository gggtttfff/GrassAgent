// src/sandbox/sshBackend.ts
// 通过 SSH 连到远程主机,在那边起 daemon,再开隧道把调用转过去。
//
// 和 Docker 后端的差别只在「东西在哪」:
// Docker 后端把 daemon 装进容器,这个后端把它装到远程机器上。
// 对控制面来说接口一样——创建、转发、销毁。

import type { Logger } from '../logger.ts'
import type { ProvisionRequest, RunningSandbox, SandboxBackend } from './backend.ts'
import { deployRemoteDaemon, type RemoteDaemon } from './sshDeploy.ts'
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
  knownHostsPath?: string
  /** 远程工作区的真实路径。模型看到的是 /workspace。 */
  remoteWorkspace?: string
  /** 远程上放 daemon 源码的根目录。默认 /tmp。 */
  remoteRoot?: string
  timeoutMs?: number
  logger?: Logger
}

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
    daemon = await deployRemoteDaemon({
      client,
      sandboxId: request.sandboxId,
      token: request.token,
      remoteWorkspace: config.remoteWorkspace,
      diskMb: request.diskMb,
      remoteRoot: options.remoteRoot,
      logger: options.logger,
    })
    tunnel = await openSshTunnel(client, {
      dstHost: '127.0.0.1',
      dstPort: daemon.port,
      logger: options.logger,
    })
    // 走一遍协议,确认远程 daemon 的版本对得上。
    const health = await postCall(tunnel.localPort, request.token, {
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'health',
    })
    if (!health.ok || health.version !== SANDBOX_PROTOCOL_VERSION) {
      throw new Error(`远端协议版本不符: ${health.ok ? health.version : health.error}`)
    }
    return runningFrom(client, daemon, tunnel, request)
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
): RunningSandbox {
  return {
    sandboxId: request.sandboxId,
    // 模型看到的根固定是 /workspace,真实路径在远程那一侧。
    workspaceRoot: '/workspace',
    token: request.token,
    localWorkspace: daemon.remoteDirectory,
    keep: request.keep,
    forward: (call) => postCall(tunnel.localPort, request.token, call),
    destroy: async ({ removeVolume }) => {
      await tunnel.close().catch(() => undefined)
      await daemon.stop().catch(() => undefined)
      client.end()
      // SSH 后端没有本地卷。远程目录由 daemon.stop 清掉。
      void removeVolume
    },
  }
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
    knownHostsPath: options.knownHostsPath,
    remoteWorkspace: options.remoteWorkspace,
    timeoutMs: options.timeoutMs,
  })
}
