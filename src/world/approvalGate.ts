// src/world/approvalGate.ts
// 审批回答「要不要人点头」,沙盒回答「能碰到哪些资源」。
// 两条路分开,避免路径判断里夹进交互。

/** 没有审批实现时用 unavailable,调用方必须当成拒绝。 */
export type ApprovalDecision = 'allow' | 'deny' | 'unavailable'

export type ApprovalAction = {
  kind: 'write' | 'edit' | 'exec' | 'escalate' | 'skill'
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
 * 启动时的窄门。
 *
 * `.env` 里写死 danger-full-access 是用户本人的动作,不需要再问一次;
 * 但它只是「启动」这一次的授权,不替别的升级背书——技能加载、会话内切换
 * 仍然走自己的门,拿到的是 unavailable。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createStartupEscalationGate(): ApprovalGate {
  return {
    async decide(action) {
      return action.kind === 'escalate' ? 'allow' : 'unavailable'
    },
  }
}

/**
 * 加载技能必须拿到 allow。
 *
 * 技能正文是仓库里的文本,拿到它就等于让模型按别人的指令做事。
 * deny 和 unavailable 都是拒绝,不返回正文。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function assertSkillAllowed(
  gate: ApprovalGate | undefined,
  summary: string,
): Promise<void> {
  const decision = gate ? await gate.decide({ kind: 'skill', summary }) : 'unavailable'
  if (decision !== 'allow') {
    throw new Error(`审批拒绝加载技能: ${summary}`)
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
