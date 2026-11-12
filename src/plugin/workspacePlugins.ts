// src/plugin/workspacePlugins.ts
// 工作区 .grass/plugins 只在信任之后登记清单。
// 信任记录在宿主目录,不在工作区里。工作区清单不能申请 host.exec。

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { parseJson, stringifyJson } from '../core/jsonSafety.ts'
import { createPathGuard } from '../core/pathGuard.ts'
import type { Logger } from '../core/logger.ts'
import { assertManifest, PluginError, type PluginManifest } from './contract.ts'
import type { PluginHost } from './host.ts'

export type PluginTrustMode = 'ask' | 'allow' | 'deny'

export type WorkspacePluginLoad = {
  loaded: string[]
  skipped: string[]
  trusted: boolean
}

const MANIFEST_NAME = 'grass-plugin.json'

/**
 * 工作区来源的清单不能站到宿主平面,也不能申请 host.exec。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function assertWorkspaceSource(manifest: PluginManifest): void {
  if (manifest.plane !== 'world' || manifest.capabilities.includes('host.exec')) {
    throw new PluginError(`工作区插件 ${manifest.id} 不能申请 host.exec`)
  }
}

/**
 * 读取 .grass/plugins/<目录>/grass-plugin.json。目录不存在就是没有外部插件。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function listWorkspaceManifests(workspace: string): Promise<string[]> {
  const guard = await createPathGuard(workspace)
  const root = path.join(guard.workspace, '.grass', 'plugins')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const manifests: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(root, entry.name, MANIFEST_NAME)
    try {
      await guard.resolve(manifestPath)
    } catch {
      continue
    }
    manifests.push(manifestPath)
  }
  return manifests.sort()
}

async function readTrust(trustFile: string, workspace: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(trustFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const parsed = parseJson(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const workspaces = (parsed as { workspaces?: unknown }).workspaces
  if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) return false
  return (workspaces as Record<string, unknown>)[workspace] === 'allow'
}

async function rememberTrust(trustFile: string, workspace: string): Promise<void> {
  let existing: { workspaces?: Record<string, string> } = {}
  try {
    const text = await readFile(trustFile, 'utf8')
    const parsed = parseJson(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as { workspaces?: Record<string, string> }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const workspaces = { ...(existing.workspaces ?? {}), [workspace]: 'allow' }
  await mkdir(path.dirname(trustFile), { recursive: true })
  await writeFile(trustFile, stringifyJson({ workspaces }), 'utf8')
}

function manifestFromJson(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginError('插件清单必须是对象')
  }
  const body = value as Record<string, unknown>
  const contributes = body.contributes
  if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) {
    throw new PluginError('插件清单缺少 contributes')
  }
  return {
    id: String(body.id ?? ''),
    version: String(body.version ?? ''),
    api: Number(body.api),
    plane: body.plane as PluginManifest['plane'],
    order: Number(body.order ?? 0),
    failure: body.failure as PluginManifest['failure'],
    capabilities: Array.isArray(body.capabilities) ? body.capabilities as PluginManifest['capabilities'] : [],
    contributes: contributes as PluginManifest['contributes'],
  }
}

/**
 * 先决定信不信任,再登记清单。没信任就不解析进宿主。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function loadWorkspacePlugins(options: {
  host: PluginHost
  workspace: string
  trustMode: PluginTrustMode
  trustFile: string
  logger: Logger
  ask?: (question: string) => Promise<boolean>
}): Promise<WorkspacePluginLoad> {
  const guard = await createPathGuard(options.workspace)
  const manifests = await listWorkspaceManifests(options.workspace)
  if (manifests.length === 0) return { loaded: [], skipped: [], trusted: false }

  let trustFile = options.trustFile
  try {
    await guard.resolve(trustFile)
    trustFile = ''
    options.logger.warn({ trustFile: options.trustFile }, '信任记录在工作区内,已忽略')
  } catch {
    // 工作区外的路径才是宿主记录
  }

  let trusted = false
  if (options.trustMode === 'allow') trusted = true
  else if (options.trustMode === 'deny') trusted = false
  else {
    trusted = trustFile ? await readTrust(trustFile, guard.workspace) : false
    if (!trusted && options.ask) {
      trusted = await options.ask(
        '信任这个工作区的 .grass/plugins 吗?回答 yes 才登记清单。工作区插件不能申请 host.exec。',
      )
    }
  }

  if (!trusted) {
    options.logger.warn({ workspace: guard.workspace, count: manifests.length }, '工作区插件未获信任,已跳过')
    return { loaded: [], skipped: manifests, trusted: false }
  }
  if (options.trustMode === 'ask' && trustFile) {
    await rememberTrust(trustFile, guard.workspace).catch((error: unknown) => {
      options.logger.warn({ errorMessage: (error as Error).message }, '没能记下工作区插件信任')
    })
  }

  const loaded: string[] = []
  const skipped: string[] = []
  for (const manifestPath of manifests) {
    try {
      const parsed = parseJson(await readFile(manifestPath, 'utf8'))
      const manifest = manifestFromJson(parsed)
      assertWorkspaceSource(manifest)
      assertManifest(manifest)
      options.host.register(manifest)
      loaded.push(manifest.id)
      options.logger.info({ pluginId: manifest.id, manifestPath }, '已登记工作区插件清单,不加载可执行入口')
    } catch (error) {
      skipped.push(manifestPath)
      options.logger.warn({
        manifestPath,
        errorMessage: (error as Error).message,
      }, '跳过工作区插件')
    }
  }
  return { loaded, skipped, trusted: true }
}
