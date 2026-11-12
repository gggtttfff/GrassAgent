import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { bindCloudSandbox, CloudSandboxBusyError } from '../../src/plugin/cloudSession.ts'
import { createPluginHost, registerBuiltinPlugins } from '../../src/plugin/host.ts'
import { createRouterTools, EXECUTION_TOOL_NAMES } from '../../src/plugin/router.ts'

test('路由工具表里没有执行工具', () => {
  const host = createPluginHost()
  registerBuiltinPlugins(host, { skillEval: false, profile: 'router' })
  const names = host.contributedTools()
  assert.deepEqual([...names].sort(), ['ask_user', 'dispatch_worker', 'recall_worker'])
  for (const executionTool of EXECUTION_TOOL_NAMES) {
    assert.equal(names.includes(executionTool), false, executionTool)
  }
})

test('路由把任务派给新的 worker,自己不绑定沙盒', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-router-'))
  const tools = createRouterTools({ directory })
  const dispatch = tools.find((tool) => tool.name === 'dispatch_worker')
  const recall = tools.find((tool) => tool.name === 'recall_worker')
  assert.ok(dispatch && recall)
  const first = await dispatch.execute({ prompt: '修测试' })
  const second = await dispatch.execute({ prompt: '看日志' })
  const firstId = /worker 会话 (\S+)/.exec(first)?.[1]
  const secondId = /worker 会话 (\S+)/.exec(second)?.[1]
  assert.ok(firstId && secondId && firstId !== secondId)
  assert.match(await recall.execute({ session_id: firstId }), /未绑定/)

  await bindCloudSandbox({ directory, sessionId: firstId, sandboxId: 'box-a' })
  await assert.rejects(
    () => bindCloudSandbox({ directory, sessionId: secondId, sandboxId: 'box-a' }),
    CloudSandboxBusyError,
  )
  assert.match(await recall.execute({ session_id: firstId }), /box-a/)
})

test('worker 交回短状态后,路由只提示去问用户', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-router-'))
  const tools = createRouterTools({ directory })
  const dispatch = tools.find((tool) => tool.name === 'dispatch_worker')!
  const recall = tools.find((tool) => tool.name === 'recall_worker')!
  const sent = await dispatch.execute({ prompt: '是否推送' })
  const sessionId = /worker 会话 (\S+)/.exec(sent)?.[1]
  assert.ok(sessionId)
  await bindCloudSandbox({ directory, sessionId, sandboxId: 'box-b' })
  const { writeCloudHandoff } = await import('../../src/plugin/cloudSession.ts')
  await writeCloudHandoff({
    directory,
    sessionId,
    sandboxId: 'box-b',
    summary: '是否允许推送',
    status: 'needs_user',
  })
  const text = await recall.execute({ session_id: sessionId })
  assert.match(text, /ask_user/)
  assert.match(text, /是否允许推送/)
})
