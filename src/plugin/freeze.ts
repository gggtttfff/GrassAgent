// src/plugin/freeze.ts
// 启动时读入的钩子和危险命令在会话里不再跟着文件变。

import type { DangerousCommandRule } from '../agent/dangerousCommands.ts'
import type { HookDefinition } from '../agent/hooks.ts'

/** 作者：Pieory 创建日期：2025-07-18 */
export function freezeHookDefinitions(definitions: readonly HookDefinition[]): HookDefinition[] {
  return Object.freeze(definitions.map((definition) => Object.freeze({ ...definition }))) as HookDefinition[]
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function freezeDangerousCommands(
  rules: readonly DangerousCommandRule[],
): DangerousCommandRule[] {
  return Object.freeze(rules.map((rule) => Object.freeze({ ...rule }))) as DangerousCommandRule[]
}
