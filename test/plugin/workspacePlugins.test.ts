import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLogger } from '../../src/core/logger.ts'
import { createPluginHost } from '../../src/plugin/host.ts'
import { loadWorkspacePlugins } from '../../src/plugin/workspacePlugins.ts'

const logger = createLogger({
  level: 'silent',
  format: 'json',
  destination: { write() {} },
})

async function workspaceWith(manifest: unknown): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-plugins-'))
  const dir = path.join(workspace, '.grass', 'plugins', 'sample')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'grass-plugin.json'), JSON.stringify(manifest))
  return workspace
}

const worldManifest = {
  id: 'example.notes',
  version: '1.0.0',
  api: 1,
  plane: 'world',
  order: 400,
  failure: 'isolate',
  capabilities: ['world.read'],
  contributes: { tools: ['example_notes'] },
}

test('没信任就不登记工作区插件', async () => {
  const workspace = await workspaceWith(worldManifest)
  const host = createPluginHost()
  const result = await loadWorkspacePlugins({
    host,
    workspace,
    trustMode: 'deny',
    trustFile: path.join(os.tmpdir(), 'unused-trust.json'),
    logger,
  })
  assert.equal(result.trusted, false)
  assert.deepEqual(result.loaded, [])
  assert.equal(host.ids().includes('example.notes'), false)
})

test('信任之后仍拒绝 host.exec,合法清单只登记不执行', async () => {
  const workspace = await workspaceWith({
    ...worldManifest,
    id: 'example.exec',
    plane: 'host',
    capabilities: ['host.exec'],
    contributes: {},
  })
  const host = createPluginHost()
  const denied = await loadWorkspacePlugins({
    host,
    workspace,
    trustMode: 'allow',
    trustFile: path.join(os.tmpdir(), 'unused-trust.json'),
    logger,
  })
  assert.equal(denied.trusted, true)
  assert.deepEqual(denied.loaded, [])
  assert.equal(host.ids().includes('example.exec'), false)

  const allowedWorkspace = await workspaceWith(worldManifest)
  const allowedHost = createPluginHost()
  const allowed = await loadWorkspacePlugins({
    host: allowedHost,
    workspace: allowedWorkspace,
    trustMode: 'allow',
    trustFile: path.join(os.tmpdir(), 'unused-trust.json'),
    logger,
  })
  assert.deepEqual(allowed.loaded, ['example.notes'])
  assert.equal(allowedHost.contributedTools().includes('example_notes'), true)
})

test('问过一次后记在工作区外,下次不再问', async () => {
  const workspace = await workspaceWith(worldManifest)
  const trustFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'grass-trust-')), 'plugin-trust.json')
  let asked = 0
  const first = createPluginHost()
  const loaded = await loadWorkspacePlugins({
    host: first,
    workspace,
    trustMode: 'ask',
    trustFile,
    logger,
    ask: async () => {
      asked += 1
      return true
    },
  })
  assert.equal(asked, 1)
  assert.deepEqual(loaded.loaded, ['example.notes'])
  const stored = await readFile(trustFile, 'utf8')
  assert.equal(stored.includes(workspace) || stored.includes('allow'), true)

  const second = createPluginHost()
  const again = await loadWorkspacePlugins({
    host: second,
    workspace,
    trustMode: 'ask',
    trustFile,
    logger,
  })
  assert.equal(again.trusted, true)
  assert.deepEqual(again.loaded, ['example.notes'])
})
