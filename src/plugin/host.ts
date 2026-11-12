// src/plugin/host.ts
// 进程内插件注册表。同名工具、命令、插件 id 在启动时失败,不覆盖。

import { assertManifest, type PluginManifest } from './contract.ts'
import { PluginError } from './contract.ts'

export type PluginHost = {
  register(manifest: PluginManifest): void
  contributedTools(): readonly string[]
  contributedCommands(): readonly string[]
  ids(): readonly string[]
}

/**
 * 空的宿主。内置插件由调用方按固定顺序注册。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createPluginHost(): PluginHost {
  const manifests: PluginManifest[] = []
  const ids = new Set<string>()
  const tools = new Set<string>()
  const commands = new Set<string>()

  return {
    register(manifest) {
      assertManifest(manifest)
      if (ids.has(manifest.id)) throw new PluginError(`插件 id 冲突: ${manifest.id}`)
      for (const name of manifest.contributes.tools ?? []) {
        if (tools.has(name)) throw new PluginError(`工具名冲突: ${name}`)
        tools.add(name)
      }
      for (const name of manifest.contributes.commands ?? []) {
        if (commands.has(name)) throw new PluginError(`命令名冲突: ${name}`)
        commands.add(name)
      }
      ids.add(manifest.id)
      manifests.push(manifest)
      manifests.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    },
    contributedTools() {
      return manifests.flatMap((manifest) => [...(manifest.contributes.tools ?? [])])
    },
    contributedCommands() {
      return manifests.flatMap((manifest) => [...(manifest.contributes.commands ?? [])])
    },
    ids() {
      return manifests.map((manifest) => manifest.id)
    },
  }
}

export const BUILTIN_COMMANDS = [
  'clear',
  'new',
  'sessions',
  'resume',
  'export',
  'import',
  'instructions',
  'skills',
  'mode',
  'compact',
] as const

/**
 * 注册 Grass 自带的插件清单。技能评估默认不注册。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function registerBuiltinPlugins(host: PluginHost, options: { skillEval: boolean }): void {
  host.register({
    id: 'grass.tools.files',
    version: '1.0.0',
    api: 1,
    plane: 'world',
    order: 100,
    failure: 'isolate',
    capabilities: ['world.read', 'world.write', 'world.exec'],
    contributes: { tools: ['read_file', 'write_file', 'edit', 'edit_batch', 'run_bash'] },
  })
  host.register({
    id: 'grass.guard.dangerous-commands',
    version: '1.0.0',
    api: 1,
    plane: 'host',
    order: 90,
    failure: 'isolate',
    capabilities: ['host.readConfig'],
    contributes: {},
  })
  host.register({
    id: 'grass.tools.monitor',
    version: '1.0.0',
    api: 1,
    plane: 'world',
    order: 105,
    failure: 'isolate',
    capabilities: ['world.exec'],
    contributes: { tools: ['monitor'] },
  })
  host.register({
    id: 'grass.tools.skills',
    version: '1.0.0',
    api: 1,
    plane: 'world',
    order: 110,
    failure: 'isolate',
    capabilities: ['world.read', 'approval.ask'],
    contributes: { tools: ['load_skill'] },
  })
  host.register({
    id: 'grass.tools.ask-user',
    version: '1.0.0',
    api: 1,
    plane: 'host',
    order: 120,
    failure: 'isolate',
    capabilities: ['ui.ask'],
    contributes: { tools: ['ask_user'] },
  })
  host.register({
    id: 'grass.session.commands',
    version: '1.0.0',
    api: 1,
    plane: 'host',
    order: 130,
    failure: 'isolate',
    capabilities: ['session.read', 'session.sync', 'session.switch', 'ui.notice'],
    contributes: { commands: BUILTIN_COMMANDS },
  })
  host.register({
    id: 'grass.world.local',
    version: '1.0.0',
    api: 1,
    plane: 'world',
    order: 10,
    failure: 'fatal',
    capabilities: [],
    contributes: { worlds: ['local'] },
  })
  host.register({
    id: 'grass.world.remote',
    version: '1.0.0',
    api: 1,
    plane: 'world',
    order: 11,
    failure: 'fatal',
    capabilities: [],
    contributes: { worlds: ['remote'] },
  })
  host.register({
    id: 'grass.llm.openai',
    version: '1.0.0',
    api: 1,
    plane: 'host',
    order: 20,
    failure: 'isolate',
    capabilities: [],
    contributes: { providers: ['openai'] },
  })
  host.register({
    id: 'grass.instructions',
    version: '1.0.0',
    api: 1,
    plane: 'world',
    order: 30,
    failure: 'isolate',
    capabilities: ['world.read'],
    contributes: { prompt: ['rules', 'skills'] },
  })
  if (!options.skillEval) return
  host.register({
    id: 'grass.rsi',
    version: '1.0.0',
    api: 1,
    plane: 'host',
    order: 200,
    failure: 'isolate',
    capabilities: ['host.readConfig'],
    contributes: {},
  })
}

/**
 * 实际注册出来的工具名必须和清单一致。多一个或少一个都是组装错误。
 * load_skill 在没有技能时不注册,清单里仍保留这个名字,调用方传入 omit。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function assertToolNames(host: PluginHost, actual: readonly string[], omit: readonly string[] = []): void {
  const expected = host.contributedTools().filter((name) => !omit.includes(name))
  const left = [...expected].sort()
  const right = [...actual].sort()
  if (left.join('\n') !== right.join('\n')) {
    throw new PluginError(`工具表和插件清单不一致: 清单=${left.join(',')} 实际=${right.join(',')}`)
  }
}
