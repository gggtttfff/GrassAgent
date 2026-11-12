// src/sandbox/openWorld.ts
// 按配置打开执行世界。远程创建失败就停在这里,不退回本机工作区。

import type { AgentConfig } from '../config.ts'
import type { ExecutionWorld, SandboxMode } from '../world/executionWorld.ts'
import type { ApprovalGate } from '../world/approvalGate.ts'
import { createLocalWorld } from '../world/localWorld.ts'
import { parseJson } from '../core/jsonSafety.ts'
import { createRemoteWorld, type RemoteWorldOptions } from './remoteWorld.ts'
import { createSshBackend } from './sshBackend.ts'
import { createControlPlane } from './control.ts'
import { listenControl } from './controlHttp.ts'
import type { CreateSandboxInput, SandboxHandle } from './control.ts'
import type { ProvisionProgress } from './backend.ts'

/**
 * 发给控制面的创建参数。这里没有 API Key,密钥留在 Grass 进程里。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function sandboxCreateBody(config: AgentConfig, sessionId: string): CreateSandboxInput {
  return {
    image: config.SandboxImage ?? '',
    repoUrl: config.SandboxRepoUrl ?? '',
    credentialRef: config.SandboxCredentialRef,
    ttlMs: config.SandboxTtlMs,
    cpu: config.SandboxCpu,
    memoryMb: config.SandboxMemoryMb,
    diskMb: config.SandboxDiskMb,
    networkAllowlist: config.SandboxNetworkAllowlist.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    keep: config.SandboxKeep,
    sessionId,
  }
}

/**
 * 打开执行世界。
 *
 * 远程世界有两条路:
 * - 配了控制面地址:控制面是独立进程,Grass 通过 HTTP 连它。
 * - 没配,而且后端是 ssh:控制面就在本进程里起。SSH 后端不需要对外
 *   开端口——控制面只监听回环,外面谁也进不来。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export type OpenWorldOptions = {
  sessionId: string
  fetchImpl?: typeof fetch
  /** 创建沙盒的进度。只在控制面跑在本进程时可用。 */
  onProgress?: (event: ProvisionProgress) => void
  /** danger-full-access 必须先过审批。配置里写死的升级由调用方提供一个放行的门。 */
  approval?: ApprovalGate
}

/**
 * 打开执行世界。选哪个插件在 plugin/worldPlugins.ts,这里只提供两边的实现。
 * 远程创建失败由调用方停住,本函数不会改绑本地世界。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function openExecutionWorld(
  config: AgentConfig,
  options: OpenWorldOptions,
): Promise<ExecutionWorld> {
  const { openSelectedWorld } = await import('../plugin/worldPlugins.ts')
  return openSelectedWorld(config, options)
}

/** 本地世界插件的实现。作者：Pieory 创建日期：2025-07-18 */
export async function openLocalWorldFromConfig(
  config: AgentConfig,
  options: OpenWorldOptions,
): Promise<ExecutionWorld> {
  return createLocalWorld({
    workspace: config.Workspace,
    mode: config.SandboxMode,
    approval: options.approval,
  })
}

/** 远程世界插件的实现。失败就抛,不改绑本地。作者：Pieory 创建日期：2025-07-18 */
export async function openRemoteWorldFromConfig(
  config: AgentConfig,
  options: OpenWorldOptions,
): Promise<ExecutionWorld> {
  const fetchImpl = options.fetchImpl ?? fetch

  // SSH 后端且没指定控制面地址:控制面在本进程里起。
  if (!config.SandboxControlUrl && config.SandboxBackend === 'ssh') {
    return openInProcessControlPlane(config, options.sessionId, options.onProgress)
  }

  const controlUrl = config.SandboxControlUrl
  if (!controlUrl) throw new Error('远程执行世界必须配置控制面地址')
  if (config.SandboxId) {
    const handle = await postJson<SandboxHandle>(
      fetchImpl,
      joinUrl(controlUrl, `/v1/sandboxes/${config.SandboxId}/attach`),
      { ttlMs: config.SandboxTtlMs, sessionId: options.sessionId },
      config.SandboxControlToken,
    )
    return openRemoteWorld({
      controlUrl,
      sandboxId: handle.sandboxId,
      token: handle.token,
      workspaceRoot: handle.workspaceRoot,
      mode: config.SandboxMode,
      fetchImpl,
    })
  }
  const handle = await postJson<SandboxHandle>(
    fetchImpl,
    joinUrl(controlUrl, '/v1/sandboxes'),
    sandboxCreateBody(config, options.sessionId),
    config.SandboxControlToken,
  )
  return openRemoteWorld({
    controlUrl,
    sandboxId: handle.sandboxId,
    token: handle.token,
    workspaceRoot: handle.workspaceRoot,
    mode: config.SandboxMode,
    fetchImpl,
  })
}

/**
 * 造好远程世界之后立刻把模式对齐到配置。
 *
 * daemon 起来时是 workspace-write。对齐发生在任何工具调用之前,所以没有窗口期。
 * 对齐失败就把沙盒放掉——留一个模式和配置不符的世界,比直接失败更危险。
 */
async function openRemoteWorld(options: RemoteWorldOptions): Promise<ExecutionWorld> {
  const world = createRemoteWorld(options)
  try {
    await world.setMode(options.mode ?? 'workspace-write')
  } catch (error) {
    await world.close().catch(() => undefined)
    throw error
  }
  return world
}

/**
 * 在本进程里起一个控制面,用 SSH 后端。
 *
 * 控制面只监听回环。Grass 通过它创建远程沙盒,调用转到远程的 daemon。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function openInProcessControlPlane(
  config: AgentConfig,
  sessionId: string,
  onProgress?: (event: ProvisionProgress) => void,
): Promise<ExecutionWorld> {
  const backend = createSshBackend({
    host: config.SandboxSshHost ?? '',
    username: config.SandboxSshUser ?? '',
    port: config.SandboxSshPort,
    privateKeyPath: config.SandboxSshKeyPath,
    privateKeyPassphrase: config.SandboxSshKeyPassphrase,
    agentPath: config.SandboxSshAgent,
    password: config.SandboxSshPassword,
    knownHostsPath: config.SandboxSshKnownHostsPath,
    remoteWorkspace: config.SandboxSshWorkspace,
    remoteRoot: config.SandboxSshRemoteRoot,
    healthTimeoutMs: config.SandboxSshHealthTimeoutMs,
    callTimeoutMs: config.SandboxSshCallTimeoutMs,
    orphanMinimumAgeMs: config.SandboxSshOrphanAgeMs,
    keepRetentionMs: config.SandboxSshKeepRetentionMs,
    reconnectAttempts: config.SandboxSshReconnectAttempts,
    reconnectCooldownMs: config.SandboxSshReconnectCooldownMs,
    timeoutMs: config.SandboxSshTimeoutMs,
  })
  const plane = createControlPlane({ backend, controlToken: config.SandboxControlToken, onProgress })
  const listening = await listenControl(plane)
  try {
    // 配了 SandboxId 就走挂回。不区分的话这个配置在 SSH 后端下形同虚设,
    // 每次启动都新建一个沙盒,原来那个工作区再也接不回去。
    const handle = config.SandboxId
      ? await postJson<SandboxHandle>(
        fetch,
        joinUrl(listening.url, `/v1/sandboxes/${config.SandboxId}/attach`),
        { ttlMs: config.SandboxTtlMs, sessionId },
        config.SandboxControlToken,
      )
      : await postJson<SandboxHandle>(
        fetch,
        joinUrl(listening.url, '/v1/sandboxes'),
        sandboxCreateBody(config, sessionId),
        config.SandboxControlToken,
      )
    const world = await openRemoteWorld({
      controlUrl: listening.url,
      sandboxId: handle.sandboxId,
      token: handle.token,
      workspaceRoot: handle.workspaceRoot,
      mode: config.SandboxMode,
    })
    // 控制面跟着世界一起关。远端 daemon 才会被回收。
    const originalClose = world.close.bind(world)
    world.close = async () => {
      await originalClose()
      await listening.close().catch(() => undefined)
    }
    return world
  } catch (error) {
    await listening.close().catch(() => undefined)
    throw error
  }
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  controlToken?: string,
): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 控制面要校验调用方凭据。没配令牌时不带这个头。
        ...(controlToken ? { authorization: `Bearer ${controlToken}` } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`控制面不可达,没有创建远程世界: ${(error as Error).message}`)
  }
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text ? parseJson(text) : {}
  } catch {
    throw new Error(`控制面返回的不是 JSON: ${response.status}`)
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : `控制面拒绝创建沙盒: ${response.status}`
    throw new Error(message)
  }
  return parsed as T
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/$/, '')}${suffix}`
}
