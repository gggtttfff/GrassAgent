// src/sandbox/backend.ts
// 控制面把「创建出来的沙盒」收成同一份形状。
// Docker 和测试用的进程内后端都实现它,失败时由后端自己清掉半成品。

import type { SandboxCall, SandboxResult } from './protocol.ts'

export type ProvisionRequest = {
  sandboxId: string
  token: string
  image: string
  repoUrl: string
  credential: string | null
  cpu: number
  memoryMb: number
  diskMb: number
  networkAllowlist: readonly string[]
  keep: boolean
  sessionId?: string
}

export type RunningSandbox = {
  sandboxId: string
  /** 模型看到的根,容器里固定是 /workspace。 */
  workspaceRoot: string
  token: string
  localWorkspace: string
  keep: boolean
  forward: (call: SandboxCall) => Promise<SandboxResult>
  destroy: (options: { removeVolume: boolean }) => Promise<void>
}

export interface SandboxBackend {
  /** 创建沙盒。健康检查失败时不把半成品交出去。作者：Pieory 创建日期：2025-07-18 */
  provision(request: ProvisionRequest): Promise<RunningSandbox>
  /**
   * 挂回 keep 留下的卷。卷不在就返回 null,不要新建空目录冒充原来的工作区。
   * 作者：Pieory 创建日期：2025-07-18
   */
  attach(sandboxId: string): Promise<RunningSandbox | null>
}
