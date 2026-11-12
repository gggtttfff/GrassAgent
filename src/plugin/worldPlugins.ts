// src/plugin/worldPlugins.ts
// 按配置选一个世界插件。远程失败不改绑本地。

import type { AgentConfig } from '../config.ts'
import type { ExecutionWorld } from '../world/executionWorld.ts'
import type { ApprovalGate } from '../world/approvalGate.ts'
import type { ProvisionProgress } from '../sandbox/backend.ts'
import { openLocalWorldFromConfig, openRemoteWorldFromConfig } from '../sandbox/openWorld.ts'

export const LOCAL_WORLD_PLUGIN_ID = 'grass.world.local'
export const REMOTE_WORLD_PLUGIN_ID = 'grass.world.remote'

export type WorldOpenOptions = {
  sessionId: string
  fetchImpl?: typeof fetch
  onProgress?: (event: ProvisionProgress) => void
  approval?: ApprovalGate
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function worldPluginId(executionWorld: AgentConfig['ExecutionWorld']): string {
  return executionWorld === 'remote' ? REMOTE_WORLD_PLUGIN_ID : LOCAL_WORLD_PLUGIN_ID
}

/**
 * 打开选中的世界插件。调用方不要在失败时再试另一个插件。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function openSelectedWorld(
  config: AgentConfig,
  options: WorldOpenOptions,
): Promise<ExecutionWorld> {
  if (worldPluginId(config.ExecutionWorld) === LOCAL_WORLD_PLUGIN_ID) {
    return openLocalWorldFromConfig(config, options)
  }
  return openRemoteWorldFromConfig(config, options)
}
