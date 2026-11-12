// src/plugin/contract.ts
// 插件清单和能力闭集。api 与沙盒协议版本分开,对不上就拒绝加载。

import { HOOK_EVENTS, type HookEventName } from '../agent/hooks.ts'

/** 插件 API。沙盒协议版本不跟这个数走。作者：Pieory 创建日期：2025-07-18 */
export const PLUGIN_API_VERSION = 1

export const CAPABILITIES = [
  'world.read',
  'world.write',
  'world.exec',
  'world.output',
  'host.exec',
  'host.readConfig',
  'session.read',
  'session.sync',
  'session.switch',
  'prompt.annotate',
  'ui.ask',
  'ui.notice',
  'approval.ask',
] as const

export type Capability = (typeof CAPABILITIES)[number]

const WORLD_CAPABILITIES = new Set<Capability>(['world.read', 'world.write', 'world.exec', 'world.output'])
const HOST_CAPABILITIES = new Set<Capability>(['host.exec', 'host.readConfig'])

export type PluginPlane = 'world' | 'host'
export type PluginFailure = 'isolate' | 'fatal'

export type PluginContributes = {
  tools?: readonly string[]
  hooks?: readonly HookEventName[]
  commands?: readonly string[]
  worlds?: readonly string[]
  providers?: readonly string[]
  prompt?: readonly string[]
}

export type PluginManifest = {
  id: string
  version: string
  api: number
  plane: PluginPlane
  order: number
  failure: PluginFailure
  capabilities: readonly Capability[]
  contributes: PluginContributes
}

export class PluginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginError'
  }
}

/**
 * 校验一份清单。能力多要、平面和能力对不上、fatal 用错地方,都在注册时失败。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function assertManifest(manifest: PluginManifest): void {
  if (!manifest.id.trim()) throw new PluginError('插件 id 不能为空')
  if (manifest.api !== PLUGIN_API_VERSION) {
    throw new PluginError(`插件 ${manifest.id} 的 api 是 ${manifest.api},内核只接受 ${PLUGIN_API_VERSION}`)
  }
  const seen = new Set<string>()
  for (const capability of manifest.capabilities) {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) {
      throw new PluginError(`插件 ${manifest.id} 申请了未知能力 ${capability}`)
    }
    if (seen.has(capability)) throw new PluginError(`插件 ${manifest.id} 重复申请 ${capability}`)
    seen.add(capability)
    if (manifest.plane === 'world' && HOST_CAPABILITIES.has(capability)) {
      throw new PluginError(`世界平面插件 ${manifest.id} 不能申请 ${capability}`)
    }
    if (manifest.plane === 'host' && WORLD_CAPABILITIES.has(capability)) {
      throw new PluginError(`宿主平面插件 ${manifest.id} 不能申请 ${capability}`)
    }
  }
  if (seen.has('host.exec') && seen.has('world.write')) {
    throw new PluginError(`插件 ${manifest.id} 不能同时申请 host.exec 和 world.write`)
  }
  if (manifest.failure === 'fatal') {
    const worlds = manifest.contributes.worlds?.length ?? 0
    const hooks = manifest.contributes.hooks ?? []
    const fatalHooksOnly = hooks.length > 0 && hooks.every((hook) => hook === 'SessionStart')
    const tools = manifest.contributes.tools?.length ?? 0
    if (tools > 0 || (!worlds && !fatalHooksOnly)) {
      throw new PluginError(`插件 ${manifest.id} 的 failure=fatal 只能用于世界打开或 SessionStart`)
    }
  }
  for (const hook of manifest.contributes.hooks ?? []) {
    if (!(HOOK_EVENTS as readonly string[]).includes(hook)) {
      throw new PluginError(`插件 ${manifest.id} 贡献了未知钩子 ${hook}`)
    }
  }
}
