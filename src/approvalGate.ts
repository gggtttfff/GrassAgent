// src/approvalGate.ts
// 审批回答「要不要人点头」,沙盒回答「能碰到哪些资源」。
// 两条路分开,避免路径判断里夹进交互。

/** 没有审批实现时用 unavailable,调用方必须当成拒绝。 */
export type ApprovalDecision = 'allow' | 'deny' | 'unavailable'

export type ApprovalAction = {
  kind: 'write' | 'edit' | 'exec' | 'escalate'
  summary: string
}

export interface ApprovalGate {
  /** 对一次动作做决定。作者：Pieory 创建日期：2025-07-18 */
  decide(action: ApprovalAction): Promise<ApprovalDecision>
}

/**
 * 本地默认门:工作区内的读写和命令不再额外询问。
 * 离开当前策略(danger-full-access、加挂载、加网络、公布端口)没有人点头就拒绝。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createDefaultApprovalGate(): ApprovalGate {
  return {
    async decide(action) {
      if (action.kind === 'escalate') return 'unavailable'
      return 'allow'
    },
  }
}

/**
 * 升级动作必须拿到 allow。deny 和 unavailable 都是拒绝,不执行。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function assertEscalationAllowed(
  gate: ApprovalGate | undefined,
  summary: string,
): Promise<void> {
  const decision = gate ? await gate.decide({ kind: 'escalate', summary }) : 'unavailable'
  if (decision !== 'allow') {
    throw new Error(`审批拒绝离开当前沙盒策略: ${summary}`)
  }
}
