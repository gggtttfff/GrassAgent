// src/sandbox/remoteWorld.ts
// Grass 侧的远程世界。只连接控制面。
// 控制面不可达时抛 SandboxUnavailableError,调用方不能改绑本机目录。

import {
  PolicyDeniedError,
  SandboxUnavailableError,
  isSandboxMode,
  type DirectoryEntry,
  type ExecRequest,
  type ExecResult,
  type ExecutionWorld,
  type SandboxMode,
  type SandboxPolicy,
  type TextEdit,
} from '../world/executionWorld.ts'
import { parseJson } from '../core/jsonSafety.ts'
import { advertisedPath, advertisedPathLoose } from './lexicalPath.ts'
import {
  failureToError,
  SANDBOX_PROTOCOL_VERSION,
  type SandboxCall,
  type SandboxResult,
  type SandboxSuccess,
} from './protocol.ts'

export type RemoteWorldOptions = {
  controlUrl: string
  sandboxId: string
  token: string
  workspaceRoot: string
  /** daemon 启动时的模式。调用方随后会用 setMode 对齐到配置值。 */
  mode?: SandboxMode
  fetchImpl?: typeof fetch
}

/**
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createRemoteWorld(options: RemoteWorldOptions): ExecutionWorld {
  const policy: SandboxPolicy = {
    mode: options.mode ?? 'workspace-write',
    workspaceRoot: options.workspaceRoot,
  }
  const fetchImpl = options.fetchImpl ?? fetch
  return new RemoteWorld(options, policy, fetchImpl)
}

class RemoteWorld implements ExecutionWorld {
  readonly sandboxId: string
  readonly workspaceRoot: string
  readonly policy: SandboxPolicy
  private readonly options: RemoteWorldOptions
  private readonly fetchImpl: typeof fetch
  private closed = false

  constructor(options: RemoteWorldOptions, policy: SandboxPolicy, fetchImpl: typeof fetch) {
    this.options = options
    this.fetchImpl = fetchImpl
    this.sandboxId = options.sandboxId
    this.workspaceRoot = policy.workspaceRoot
    this.policy = policy
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async read(filePath: string): Promise<string> {
    const path = this.requestPath(filePath)
    const result = await this.rpc({ version: SANDBOX_PROTOCOL_VERSION, kind: 'read', path })
    return result.content ?? ''
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async readRaw(filePath: string): Promise<string> {
    const path = this.requestPath(filePath)
    const result = await this.rpc({ version: SANDBOX_PROTOCOL_VERSION, kind: 'read', path, raw: true })
    return result.content ?? ''
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async list(directoryPath: string): Promise<DirectoryEntry[]> {
    const path = this.requestPath(directoryPath)
    const result = await this.rpc({ version: SANDBOX_PROTOCOL_VERSION, kind: 'list', path })
    return result.entries ?? []
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async write(filePath: string, content: string): Promise<string> {
    const path = this.requestPath(filePath)
    const result = await this.rpc({
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'write',
      path,
      content,
    })
    return result.path ?? path
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async edit(filePath: string, edits: readonly TextEdit[]): Promise<string> {
    const path = this.requestPath(filePath)
    const result = await this.rpc({
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'edit',
      path,
      edits: [...edits],
    })
    return result.path ?? path
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async exec(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    if (signal?.aborted) {
      return { exitCode: 0, stdout: '', stderr: '', aborted: true, timedOut: false }
    }
    const cwd = this.requestPath(request.cwd)
    const result = await this.rpc({
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'exec',
      argv: [...request.argv],
      cwd,
      timeoutMs: request.timeoutMs,
    }, signal)
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      aborted: result.aborted ?? false,
      timedOut: result.timedOut ?? false,
    }
  }

  /**
   * 运行时切换模式。
   *
   * daemon 才是判定的那一侧,所以这里必须等它确认,不能只改本地字段冒充成功。
   * 作者：Pieory 创建日期：2025-07-18
   */
  async setMode(mode: SandboxMode): Promise<void> {
    if (!isSandboxMode(mode)) throw new Error(`未知的沙盒模式: ${String(mode)}`)
    await this.rpc({ version: SANDBOX_PROTOCOL_VERSION, kind: 'setMode', mode })
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const url = joinUrl(this.options.controlUrl, `/v1/sandboxes/${this.options.sandboxId}`)
    try {
      await this.fetchImpl(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${this.options.token}` },
      })
    } catch {
      // 控制面已经没了。会话收尾不能因此挂住。
    }
  }

  /**
   * 按当前模式决定路径怎么送出去。
   *
   * workspace-write 先做词法越界检查,省掉一次往返;danger 下放行区外路径,
   * 真不真、能不能碰,交给 daemon 在那台机器上判断。
   * 作者：Pieory 创建日期：2025-07-18
   */
  private requestPath(filePath: string): string {
    if (this.policy.mode === 'danger-full-access') {
      return advertisedPathLoose(this.workspaceRoot, filePath)
    }
    return advertisedPath(this.workspaceRoot, filePath)
  }

  private async rpc(call: SandboxCall, signal?: AbortSignal): Promise<SandboxSuccess> {
    if (this.closed) throw new SandboxUnavailableError()
    const url = joinUrl(this.options.controlUrl, `/v1/sandboxes/${this.options.sandboxId}/call`)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(call),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) throw new PolicyDeniedError('aborted')
      if (error instanceof SandboxUnavailableError) throw error
      throw new SandboxUnavailableError()
    }
    if (response.status === 404) throw new SandboxUnavailableError()
    let result: SandboxResult
    try {
      result = parseJson(await response.text()) as SandboxResult
    } catch {
      throw new SandboxUnavailableError()
    }
    if (!result.ok) throw failureToError(result)
    // daemon 回的模式是权威值。响应丢过一次也能在下次调用时对齐回来。
    if (result.mode) this.policy.mode = result.mode
    return result
  }
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/$/, '')}${suffix}`
}
