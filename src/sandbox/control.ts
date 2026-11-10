// src/sandbox/control.ts
// 控制面掌握沙盒的生命周期:创建、转发、空闲回收。
// Grass 进程只跟它说话。容器断开时调用失败,不会改去读本机工作区。

import type { Logger } from '../logger.ts'
import type { SandboxCall, SandboxResult } from './protocol.ts'
import { scrubSecrets, tokenMatches } from './protocol.ts'
import {
  createSandboxId,
  createToken,
  resolveCredentialRef,
} from './secrets.ts'
import type { ProvisionRequest, RunningSandbox, SandboxBackend } from './backend.ts'

export type TimerHandle = {
  refresh: () => void
  cancel: () => void
}

export type TimerFn = (callback: () => void, delayMs: number) => TimerHandle

export type CreateSandboxInput = {
  image: string
  repoUrl?: string
  credentialRef?: string
  ttlMs: number
  cpu: number
  memoryMb: number
  diskMb: number
  networkAllowlist?: readonly string[]
  keep?: boolean
  sessionId?: string
}

export type SandboxHandle = {
  sandboxId: string
  workspaceRoot: string
  token: string
}

type LiveSandbox = {
  sandbox: RunningSandbox
  timer: TimerHandle
  ttlMs: number
}

/**
 * 空闲计时。unref 是为了测试进程不会被一个没人刷新的计时器挂住。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function defaultIdleTimer(callback: () => void, delayMs: number): TimerHandle {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return {
    refresh() { timer.refresh() },
    cancel() { clearTimeout(timer) },
  }
}

export type ControlPlane = {
  /** 创建沙盒。callerToken 是调用方凭据,配了 controlToken 就必须对上。作者：Pieory 创建日期：2025-07-18 */
  create(input: CreateSandboxInput, callerToken?: string): Promise<SandboxHandle>
  /** 挂回沙盒。同样要校验调用方凭据。作者：Pieory 创建日期：2025-07-18 */
  attach(sandboxId: string, ttlMs: number, sessionId?: string, callerToken?: string): Promise<SandboxHandle>
  /** 作者：Pieory 创建日期：2025-07-18 */
  call(sandboxId: string, token: string, call: SandboxCall): Promise<SandboxResult>
  /** 会话结束时停掉容器。keep 为假时连目录一起删。作者：Pieory 创建日期：2025-07-18 */
  release(sandboxId: string, token: string): Promise<void>
  /** 作者：Pieory 创建日期：2025-07-18 */
  close(): Promise<void>
}

/**
 * 作者：Pieory 创建日期：2025-07-18
 */
/**
 * 创建控制面。
 *
 * controlToken 是调用方的凭据。创建沙盒和挂回沙盒都要带它——
 * 这两个接口不校验沙盒自己的令牌(挂回时甚至还没有沙盒),
 * 不挡住的话,知道 sandboxId 的人就能挂回别人的沙盒。
 *
 * 没给 controlToken 时不校验,只适合控制面在本进程里、
 * 外人根本连不上的场景。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createControlPlane(options: {
  backend: SandboxBackend
  credentialsFile?: string
  timer?: TimerFn
  logger?: Logger
  /** 调用方凭据。创建和挂回要校验它。 */
  controlToken?: string
}): ControlPlane {
  const timer = options.timer ?? defaultIdleTimer
  const live = new Map<string, LiveSandbox>()
  const secrets: string[] = []

  /** 调用方的令牌对不对。配了 controlToken 才校验。 */
  const callerAllowed = (provided: string): boolean => {
    if (!options.controlToken) return true
    return tokenMatches(provided, options.controlToken)
  }

  const plane: ControlPlane = {
    async create(input, callerToken) {
      if (!callerAllowed(callerToken ?? '')) {
        throw new Error('调用方令牌被拒绝')
      }
      const credential = await rememberSecret(input.credentialRef, options.credentialsFile, secrets)
      const request = provisionRequest(createSandboxId(), createToken(), input, credential)
      return startTracked(options, timer, live, request, input.ttlMs, secrets)
    },
    async attach(sandboxId, ttlMs, sessionId, callerToken) {
      if (!callerAllowed(callerToken ?? '')) {
        throw new Error('调用方令牌被拒绝')
      }
      let sandbox: RunningSandbox | null
      try {
        sandbox = await options.backend.attach(sandboxId)
      } catch (error) {
        throw new Error(scrubSecrets((error as Error).message, secrets))
      }
      if (!sandbox) throw new Error('沙盒卷不存在,不能挂回')
      track(live, timer, sandbox, ttlMs, () => {
        void retire(live, sandboxId, options.logger)
      })
      options.logger?.info({ sandboxId, sessionId }, '沙盒已挂回')
      return { sandboxId: sandbox.sandboxId, workspaceRoot: sandbox.workspaceRoot, token: sandbox.token }
    },
    async call(sandboxId, token, body) {
      const current = live.get(sandboxId)
      if (!current) return { ok: false, code: 'unavailable', error: 'sandbox unavailable' }
      if (!tokenMatches(token, current.sandbox.token)) {
        return { ok: false, code: 'unauthorized', error: '令牌被拒绝' }
      }
      current.timer.refresh()
      try {
        return await current.sandbox.forward(body)
      } catch (error) {
        options.logger?.error({ sandboxId, errorMessage: scrubSecrets((error as Error).message, secrets) }, '转发沙盒调用失败')
        return { ok: false, code: 'unavailable', error: 'sandbox unavailable' }
      }
    },
    async release(sandboxId, token) {
      const current = live.get(sandboxId)
      if (!current) return
      if (!tokenMatches(token, current.sandbox.token)) {
        throw new Error('令牌被拒绝')
      }
      await retire(live, sandboxId, options.logger)
    },
    async close() {
      const ids = [...live.keys()]
      for (const id of ids) await retire(live, id, options.logger)
    },
  }
  return plane
}

async function startTracked(
  options: { backend: SandboxBackend; logger?: Logger },
  timer: TimerFn,
  live: Map<string, LiveSandbox>,
  request: ProvisionRequest,
  ttlMs: number,
  secrets: string[],
): Promise<SandboxHandle> {
  let sandbox: RunningSandbox | null = null
  try {
    sandbox = await options.backend.provision(request)
    secrets.push(sandbox.token)
    track(live, timer, sandbox, ttlMs, () => {
      void retire(live, sandbox?.sandboxId ?? request.sandboxId, options.logger)
    })
    options.logger?.info({
      sandboxId: sandbox.sandboxId,
      sessionId: request.sessionId,
    }, '沙盒已创建')
    return {
      sandboxId: sandbox.sandboxId,
      workspaceRoot: sandbox.workspaceRoot,
      token: sandbox.token,
    }
  } catch (error) {
    if (sandbox) await sandbox.destroy({ removeVolume: !request.keep }).catch(() => undefined)
    throw new Error(scrubSecrets((error as Error).message, secrets))
  }
}

function track(
  live: Map<string, LiveSandbox>,
  timer: TimerFn,
  sandbox: RunningSandbox,
  ttlMs: number,
  onIdle: () => void,
): void {
  const handle = timer(onIdle, ttlMs)
  live.set(sandbox.sandboxId, { sandbox, timer: handle, ttlMs })
}

async function retire(
  live: Map<string, LiveSandbox>,
  sandboxId: string,
  logger?: Logger,
): Promise<void> {
  const current = live.get(sandboxId)
  if (!current) return
  live.delete(sandboxId)
  current.timer.cancel()
  try {
    await current.sandbox.destroy({ removeVolume: !current.sandbox.keep })
    logger?.info({ sandboxId }, '沙盒已回收')
  } catch (error) {
    logger?.error({ sandboxId, errorMessage: (error as Error).message }, '回收沙盒失败')
  }
}

async function rememberSecret(
  ref: string | undefined,
  filePath: string | undefined,
  secrets: string[],
): Promise<string | null> {
  const credential = await resolveCredentialRef(ref || undefined, filePath)
  if (credential) secrets.push(credential)
  return credential
}

function provisionRequest(
  sandboxId: string,
  token: string,
  input: CreateSandboxInput,
  credential: string | null,
): ProvisionRequest {
  return {
    sandboxId,
    token,
    image: input.image,
    repoUrl: input.repoUrl ?? '',
    credential,
    cpu: input.cpu,
    memoryMb: input.memoryMb,
    diskMb: input.diskMb,
    networkAllowlist: input.networkAllowlist ?? [],
    keep: input.keep ?? false,
    sessionId: input.sessionId,
  }
}
