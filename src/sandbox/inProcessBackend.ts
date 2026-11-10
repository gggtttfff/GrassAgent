// src/sandbox/inProcessBackend.ts
// 不启动 Docker 的后端。测试和本机演练用它。
// 协议仍然走 HTTP,这样断线和版本不符走的是同一条路。

import { mkdir, rm, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { parseJson } from '../core/jsonSafety.ts'
import { startDaemon } from './daemon.ts'
import { cloneRepository } from './gitClone.ts'
import { ADVERTISED_WORKSPACE } from './lexicalPath.ts'
import {
  SANDBOX_PROTOCOL_VERSION,
  type SandboxCall,
  type SandboxResult,
} from './protocol.ts'
import { createProcessRunner, type CommandRunner } from './commandRunner.ts'
import { writeSecretFile } from './secrets.ts'
import type { ProvisionRequest, RunningSandbox, SandboxBackend } from './backend.ts'

export type InProcessBackendOptions = {
  stateDir: string
  runner?: CommandRunner
  /** 故意报一个错的协议版本,用来测「版本不符就拆掉」。 */
  daemonVersion?: number
}

/**
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createInProcessBackend(options: InProcessBackendOptions): SandboxBackend {
  const runner = options.runner ?? createProcessRunner()
  return {
    provision: (request) => provision(options, runner, request),
    attach: (sandboxId) => attach(options, sandboxId),
  }
}

async function provision(
  options: InProcessBackendOptions,
  runner: CommandRunner,
  request: ProvisionRequest,
): Promise<RunningSandbox> {
  if (request.networkAllowlist.length > 0) {
    throw new Error('出站白名单无法在容器上装上,创建失败')
  }
  const root = path.join(options.stateDir, request.sandboxId)
  const localWorkspace = path.join(root, 'workspace')
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
  try {
    await writeSecretFile(path.join(root, 'token'), request.token)
    await mkdir(localWorkspace, { recursive: true })
    if (request.repoUrl) {
      await cloneRepository({
        repoUrl: request.repoUrl,
        destination: localWorkspace,
        token: request.credential,
        runner,
        secretDirectory: path.join(root, 'secret'),
      })
    }
    daemon = await startDaemon({
      localRoot: localWorkspace,
      advertisedRoot: ADVERTISED_WORKSPACE,
      token: request.token,
      version: options.daemonVersion,
      diskMb: request.diskMb,
    })
    const health = await postCall(daemon.url, request.token, {
      version: options.daemonVersion ?? SANDBOX_PROTOCOL_VERSION,
      kind: 'health',
    })
    if (!health.ok || health.version !== SANDBOX_PROTOCOL_VERSION) {
      throw new Error(`远端协议版本不符: ${health.ok ? health.version : health.error}`)
    }
    return runningFrom(request.sandboxId, request.token, localWorkspace, request.keep, daemon)
  } catch (error) {
    if (daemon) await daemon.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function attach(
  options: InProcessBackendOptions,
  sandboxId: string,
): Promise<RunningSandbox | null> {
  const localWorkspace = path.join(options.stateDir, sandboxId, 'workspace')
  try {
    await stat(localWorkspace)
  } catch {
    return null
  }
  const { createToken } = await import('./secrets.ts')
  const token = createToken()
  await writeSecretFile(path.join(options.stateDir, sandboxId, 'token'), token)
  const daemon = await startDaemon({
    localRoot: localWorkspace,
    advertisedRoot: ADVERTISED_WORKSPACE,
    token,
    diskMb: 10240,
  })
  return runningFrom(sandboxId, token, localWorkspace, true, daemon)
}

function runningFrom(
  sandboxId: string,
  token: string,
  localWorkspace: string,
  keep: boolean,
  daemon: Awaited<ReturnType<typeof startDaemon>>,
): RunningSandbox {
  return {
    sandboxId,
    workspaceRoot: ADVERTISED_WORKSPACE,
    token,
    localWorkspace,
    keep,
    forward: (call) => postCall(daemon.url, token, call),
    destroy: async ({ removeVolume }) => {
      await daemon.close()
      if (removeVolume) {
        await rm(path.join(localWorkspace, '..'), { recursive: true, force: true })
      }
    },
  }
}

async function postCall(url: string, token: string, call: SandboxCall): Promise<SandboxResult> {
  let response: Response
  try {
    response = await fetch(`${url}/call`, {
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
  const text = await response.text()
  try {
    return parseJson(text) as SandboxResult
  } catch {
    return { ok: false, code: 'failed', error: 'daemon 返回的不是 JSON' }
  }
}
