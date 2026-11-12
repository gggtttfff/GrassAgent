// src/plugin/builtinProviders.ts
// 内置 provider 只在这里显式登记。协议转换仍留在 src/llm/providers/。

import { listProviders } from '../llm/protocol.ts'
import '../llm/providers/index.ts'
import { PluginError } from './contract.ts'
import type { PluginHost } from './host.ts'

/**
 * 确认清单里的 provider 已经由显式 import 注册。漏了 import 就在启动时失败。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function assertRegisteredProviders(host: PluginHost): void {
  const registered = new Set(listProviders().map((provider) => provider.id))
  const expected = host.contributedProviders()
  for (const id of expected) {
    if (!registered.has(id)) {
      throw new PluginError(`插件声明了 provider ${id},但没有显式注册`)
    }
  }
}
