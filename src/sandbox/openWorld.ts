// src/sandbox/openWorld.ts
// 按配置打开执行世界。远程创建失败就停在这里,不退回本机工作区。

import type { AgentConfig } from '../config.ts'
import type { ExecutionWorld } from '../executionWorld.ts'
import { createLocalWorld } from '../localWorld.ts'
import { parseJson } from '../jsonSafety.ts'
import { createRemoteWorld } from './remoteWorld.ts'
import type { CreateSandboxInput, SandboxHandle } from './control.ts'

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
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function openExecutionWorld(
  config: AgentConfig,
  options: { sessionId: string; fetchImpl?: typeof fetch },
): Promise<ExecutionWorld> {
  if (config.ExecutionWorld !== 'remote') {
    return createLocalWorld({ workspace: config.Workspace })
  }
  const controlUrl = config.SandboxControlUrl
  if (!controlUrl) throw new Error('远程执行世界必须配置控制面地址')
  const fetchImpl = options.fetchImpl ?? fetch
  if (config.SandboxId) {
    const handle = await postJson<SandboxHandle>(
      fetchImpl,
      joinUrl(controlUrl, `/v1/sandboxes/${config.SandboxId}/attach`),
      { ttlMs: config.SandboxTtlMs, sessionId: options.sessionId },
    )
    return createRemoteWorld({
      controlUrl,
      sandboxId: handle.sandboxId,
      token: handle.token,
      workspaceRoot: handle.workspaceRoot,
      fetchImpl,
    })
  }
  const handle = await postJson<SandboxHandle>(
    fetchImpl,
    joinUrl(controlUrl, '/v1/sandboxes'),
    sandboxCreateBody(config, options.sessionId),
  )
  return createRemoteWorld({
    controlUrl,
    sandboxId: handle.sandboxId,
    token: handle.token,
    workspaceRoot: handle.workspaceRoot,
    fetchImpl,
  })
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
