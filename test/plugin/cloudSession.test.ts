import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  bindCloudSandbox,
  CloudSandboxBusyError,
  createHandoffTool,
  enqueueCloudSession,
  answerCloudHandoff,
  scheduleCloudSession,
} from '../../src/plugin/cloudSession.ts'
import { createPluginHost, registerBuiltinPlugins } from '../../src/plugin/host.ts'
import { createLocalWorld } from '../../src/world/localWorld.ts'

test('一块沙盒不能绑给两个云端会话', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-cloud-'))
  await bindCloudSandbox({ directory, sessionId: 'session-a', sandboxId: 'box-1', prompt: 'a' })
  await assert.rejects(
    () => bindCloudSandbox({ directory, sessionId: 'session-b', sandboxId: 'box-1', prompt: 'b' }),
    CloudSandboxBusyError,
  )
})

test('调度失败时关掉世界,不改绑没有 sandboxId 的本地世界', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-cloud-'))
  let closed = 0
  await assert.rejects(
    () => scheduleCloudSession({
      directory,
      prompt: '跑测试',
      openWorld: async () => ({ sandboxId: null, close: async () => { closed += 1 } }),
      run: async () => ({ needsUser: false, summary: '不会跑到' }),
    }),
    CloudSandboxBusyError,
  )
  assert.equal(closed, 1)
})

test('云端会话交回短状态,由面对用户的会话提问', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-cloud-'))
  const result = await scheduleCloudSession({
    directory,
    prompt: '要不要推送',
    openWorld: async () => ({ sandboxId: 'box-9', close: async () => {} }),
    run: async () => ({ needsUser: true, summary: '是否允许 git push' }),
  })
  assert.equal(result.status, 'needs_user')
  let asked = ''
  const answered = await answerCloudHandoff({
    directory,
    sessionId: result.sessionId,
    ask: async (question) => {
      asked = question
      return '允许'
    },
  })
  assert.equal(asked, '是否允许 git push')
  assert.equal(answered?.answer, '允许')
  const names = createHandoffTool({
    directory,
    sessionId: result.sessionId,
    sandboxId: 'box-9',
  }).name
  assert.equal(names, 'handoff_user')
})

test('短状态写在宿主目录,工作区世界写不进去', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-cloud-host-'))
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-cloud-work-'))
  const queued = await enqueueCloudSession({ directory, prompt: '看日志' })
  const tool = createHandoffTool({ directory, sessionId: queued.sessionId, sandboxId: 'box-2' })
  await bindCloudSandbox({ directory, sessionId: queued.sessionId, sandboxId: 'box-2' })
  const text = await tool.execute({ summary: '日志里有失败' })
  assert.match(text, /面对用户的会话/)
  const stored = await readFile(path.join(directory, 'sessions.json'), 'utf8')
  assert.match(stored, /日志里有失败/)
  const world = await createLocalWorld({ workspace })
  await assert.rejects(() => world.write(path.join(directory, 'sessions.json'), '篡改'))
})

test('云端配置档没有 ask_user', () => {
  const facing = createPluginHost()
  registerBuiltinPlugins(facing, { skillEval: false, profile: 'facing' })
  assert.equal(facing.contributedTools().includes('ask_user'), true)
  assert.equal(facing.contributedTools().includes('handoff_user'), false)
  const cloud = createPluginHost()
  registerBuiltinPlugins(cloud, { skillEval: false, profile: 'cloud' })
  assert.equal(cloud.contributedTools().includes('ask_user'), false)
  assert.equal(cloud.contributedTools().includes('handoff_user'), true)
  assert.equal(cloud.contributedTools().includes('read_file'), true)
})
