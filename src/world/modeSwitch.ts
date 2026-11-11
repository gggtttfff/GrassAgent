// src/world/modeSwitch.ts
// 运行中的模式切换。审批、串行化、通知都收在这里,
// 斜杠命令和快捷键拿到的是同一个入口,不会各写一套。
//
// 失败不抛异常,一律返回一句给人看的话——调用方是界面,不是业务流程。

import type { Logger } from '../core/logger.ts'
import { assertEscalationAllowed, type ApprovalGate } from './approvalGate.ts'
import { isSandboxMode, type ExecutionWorld, type SandboxMode } from './executionWorld.ts'

export type ModeSwitchResult = {
  /** 切换后的模式。失败时是切换前的那个。 */
  mode: SandboxMode
  /** 给用户看的一句话。 */
  message: string
  changed: boolean
}

export type ModeSwitcher = {
  current(): SandboxMode
  switchTo(mode: string | SandboxMode): Promise<ModeSwitchResult>
}

/**
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createModeSwitcher(options: {
  world: ExecutionWorld
  /** 切到 danger-full-access 之前要它点头。没有就是不准。 */
  approval?: ApprovalGate
  /** 切换成功后通知界面。 */
  onChanged?: (mode: SandboxMode) => void
  logger?: Logger
}): ModeSwitcher {
  // 连按快捷键时,前一次还没落定就发第二次,两边会看到同一个旧模式。
  // 串成一条链,按调用顺序执行。
  let pending: Promise<unknown> = Promise.resolve()

  const apply = async (requested: string): Promise<ModeSwitchResult> => {
    const current = options.world.policy.mode
    if (!isSandboxMode(requested)) {
      return { mode: current, message: `未知的模式 ${requested}`, changed: false }
    }
    if (requested === current) {
      return { mode: current, message: `已经是 ${current} 模式`, changed: false }
    }

    // 只有离开当前策略的那一步要人点头。收窄不需要问。
    if (requested === 'danger-full-access') {
      try {
        await assertEscalationAllowed(options.approval, 'danger-full-access')
      } catch (error) {
        const reason = (error as Error).message
        options.logger?.warn({ from: current, to: requested, reason }, '模式升级被拒绝')
        return { mode: current, message: `没有切到 ${requested}:${reason}`, changed: false }
      }
    }

    try {
      // 远程世界会在这里往返一次 daemon。它没确认就不算切成功。
      await options.world.setMode(requested)
    } catch (error) {
      // 世界没切成,本地也不改。悄悄降级比直接报错更难排查。
      const detail = (error as Error).message
      options.logger?.error({
        from: current,
        to: requested,
        errorMessage: detail,
      }, '切换沙盒模式失败')
      return { mode: current, message: `切换失败,仍是 ${current}:${detail}`, changed: false }
    }

    options.logger?.info({ from: current, to: requested }, '沙盒模式已切换')
    options.onChanged?.(requested)
    return { mode: requested, message: `已切换到 ${requested} 模式`, changed: true }
  }

  return {
    current: () => options.world.policy.mode,
    switchTo: (mode) => {
      const next = pending.then(() => apply(mode), () => apply(mode))
      pending = next.catch(() => undefined)
      return next
    },
  }
}