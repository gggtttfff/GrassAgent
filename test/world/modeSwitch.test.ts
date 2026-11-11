import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModeSwitcher } from '../../src/world/modeSwitch.ts'
import type { ApprovalGate } from '../../src/world/approvalGate.ts'
import type { ExecutionWorld, SandboxMode, SandboxPolicy } from '../../src/world/executionWorld.ts'

/** 只记决定,不真的拦。 */
function recordingGate(decision: 'allow' | 'deny' | 'unavailable'): ApprovalGate & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async decide(action) {
      calls.push(action.kind)
      return decision
    },
  }
}

/** 假世界:记录每次 setMode,可以在上面让它失败。 */
function fakeWorld(options: { failOn?: SandboxMode } = {}): ExecutionWorld & { modes: SandboxMode[] } {
  const modes: SandboxMode[] = ['workspace-write']
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/tmp' }
  return {
    modes,
    policy,
    sandboxId: null,
    workspaceRoot: '/tmp',
    async read() { return '' },
    async readRaw() { return '' },
    async list() { return [] },
    async write() { return '/tmp' },
    async edit() { return '/tmp' },
    async exec() { return { exitCode: 0, stdout: '', stderr: '', aborted: false, timedOut: false } },
    async setMode(mode) {
      if (options.failOn === mode) throw new Error('世界拒绝了这次切换')
      modes.push(mode)
      policy.mode = mode
    },
    async close() {},
  }
}

test('切到同一个模式什么都不做', async () => {
  const world = fakeWorld()
  const switcher = createModeSwitcher({ world })
  const result = await switcher.switchTo('workspace-write')
  assert.equal(result.changed, false)
  assert.equal(result.mode, 'workspace-write')
  assert.deepEqual(world.modes, ['workspace-write'])
})

test('切到只读会真的切,并且通知调用方', async () => {
  const world = fakeWorld()
  const seen: SandboxMode[] = []
  const switcher = createModeSwitcher({ world, onChanged: (mode) => seen.push(mode) })
  const result = await switcher.switchTo('read-only')
  assert.equal(result.changed, true)
  assert.equal(result.mode, 'read-only')
  assert.equal(world.policy.mode, 'read-only')
  assert.deepEqual(seen, ['read-only'])
})

test('切到全权限要审批,拒绝后模式不变', async () => {
  const world = fakeWorld()
  const gate = recordingGate('deny')
  const switcher = createModeSwitcher({ world, approval: gate })
  const result = await switcher.switchTo('danger-full-access')
  assert.equal(result.changed, false)
  assert.equal(world.policy.mode, 'workspace-write')
  assert.deepEqual(gate.calls, ['escalate'])
})

test('没有审批门就切不到全权限', async () => {
  const world = fakeWorld()
  const switcher = createModeSwitcher({ world })
  const result = await switcher.switchTo('danger-full-access')
  assert.equal(result.changed, false)
  assert.equal(world.policy.mode, 'workspace-write')
})

test('世界切换失败时保持原模式并报错', async () => {
  const world = fakeWorld({ failOn: 'read-only' })
  const switcher = createModeSwitcher({ world })
  const result = await switcher.switchTo('read-only')
  assert.equal(result.changed, false)
  assert.equal(result.mode, 'workspace-write')
  assert.equal(world.policy.mode, 'workspace-write')
  assert.match(result.message, /切换失败/)
})

test('未知的模式被挡住,不会发给世界', async () => {
  const world = fakeWorld()
  const switcher = createModeSwitcher({ world })
  const result = await switcher.switchTo('whatever')
  assert.equal(result.changed, false)
  assert.deepEqual(world.modes, ['workspace-write'])
})

test('连续切换按调用顺序执行,不会并发', async () => {
  const world = fakeWorld()
  const switcher = createModeSwitcher({ world })
  const first = switcher.switchTo('read-only')
  const second = switcher.switchTo('workspace-write')
  const third = switcher.switchTo('read-only')
  const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third])
  assert.equal(firstResult.mode, 'read-only')
  assert.equal(secondResult.mode, 'workspace-write')
  assert.equal(thirdResult.mode, 'read-only')
  assert.deepEqual(world.modes, ['workspace-write', 'read-only', 'workspace-write', 'read-only'])
})

test('审批只在升级时问,收窄不问', async () => {
  const world = fakeWorld()
  const gate = recordingGate('allow')
  const switcher = createModeSwitcher({ world, approval: gate })
  await switcher.switchTo('read-only')
  assert.deepEqual(gate.calls, [])
  await switcher.switchTo('danger-full-access')
  assert.deepEqual(gate.calls, ['escalate'])
})
