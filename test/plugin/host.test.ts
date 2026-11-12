import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { PluginError } from '../../src/plugin/contract.ts'
import { assertToolNames, createPluginHost, registerBuiltinPlugins } from '../../src/plugin/host.ts'
import { hookCommandEnv } from '../../src/plugin/ports.ts'
import { freezeDangerousCommands, freezeHookDefinitions } from '../../src/plugin/freeze.ts'
import {
  appendEffectCard,
  decideSkillChange,
  evaluateSkillChange,
  readEffectCards,
  type SkillEvalObservation,
} from '../../src/plugin/skillEval.ts'
import { worldPluginId } from '../../src/plugin/worldPlugins.ts'
import { createLocalWorld } from '../../src/world/localWorld.ts'
import { SandboxUnavailableError } from '../../src/world/executionWorld.ts'

test('插件 api 不对或同时申请宿主执行和世界写入时拒绝注册', () => {
  const host = createPluginHost()
  assert.throws(
    () => host.register({
      id: 'old',
      version: '1.0.0',
      api: 0,
      plane: 'host',
      order: 1,
      failure: 'isolate',
      capabilities: [],
      contributes: {},
    }),
    PluginError,
  )
  assert.throws(
    () => host.register({
      id: 'both',
      version: '1.0.0',
      api: 1,
      plane: 'world',
      order: 1,
      failure: 'isolate',
      capabilities: ['host.exec', 'world.write'],
      contributes: {},
    }),
    PluginError,
  )
})

test('同名工具在启动时失败,技能评估默认不进工具表', () => {
  const host = createPluginHost()
  registerBuiltinPlugins(host, { skillEval: false })
  assert.equal(host.ids().includes('grass.rsi'), false)
  assert.throws(
    () => host.register({
      id: 'extra.files',
      version: '1.0.0',
      api: 1,
      plane: 'world',
      order: 1,
      failure: 'isolate',
      capabilities: ['world.read'],
      contributes: { tools: ['read_file'] },
    }),
    PluginError,
  )
  const withEval = createPluginHost()
  registerBuiltinPlugins(withEval, { skillEval: true })
  assert.equal(withEval.ids().includes('grass.rsi'), true)
  assert.equal(withEval.contributedTools().includes('grass.rsi'), false)
  assertToolNames(
    host,
    ['read_file', 'write_file', 'edit', 'edit_batch', 'run_bash', 'monitor', 'ask_user'],
    ['load_skill'],
  )
})

test('工具清单写成 fatal 会被拒绝', () => {
  const host = createPluginHost()
  assert.throws(
    () => host.register({
      id: 'fatal.tool',
      version: '1.0.0',
      api: 1,
      plane: 'world',
      order: 1,
      failure: 'fatal',
      capabilities: ['world.read'],
      contributes: { tools: ['peek'] },
    }),
    PluginError,
  )
})

test('钩子命令环境里没有密钥名字', () => {
  const env = hookCommandEnv({
    event: 'PreToolUse',
    sessionId: 's1',
    cwd: '/work',
    source: {
      PATH: '/usr/bin',
      HOME: '/home/user',
      GRASSAGENT_API_KEY: 'secret-value',
      AWS_SECRET_ACCESS_KEY: 'also-secret',
      LANG: 'C',
    },
  })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.GRASSAGENT_HOOK_EVENT, 'PreToolUse')
  assert.equal(env.GRASSAGENT_SESSION_ID, 's1')
  assert.equal(env.GRASSAGENT_WORKSPACE, '/work')
  assert.equal(env.GRASSAGENT_API_KEY, undefined)
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined)
})

test('冻结后的钩子和危险命令改原数组不影响快照', () => {
  const hooks = freezeHookDefinitions([{ event: 'PreToolUse', command: 'echo hi' }])
  const rules = freezeDangerousCommands([{ pattern: 'rm', matcher: /rm/, reason: 'no' }])
  assert.throws(() => {
    const mutable = hooks as unknown as { command?: string }[]
    mutable[0].command = 'changed'
  })
  assert.equal(hooks[0].command, 'echo hi')
  assert.equal(rules[0].pattern, 'rm')
})

test('本地和远程世界插件按配置二选一', () => {
  assert.equal(worldPluginId('local'), 'grass.world.local')
  assert.equal(worldPluginId('remote'), 'grass.world.remote')
})

test('技能评估退步就留下上一版,基线全过则退役', () => {
  const reverted = decideSkillChange({
    candidate: [{ id: 'T1', triggerPassed: false, qualityPassed: true }],
    previous: [{ id: 'T1', triggerPassed: true, qualityPassed: true }],
    baseline: [{ id: 'T1', triggerPassed: false, qualityPassed: true }],
    candidateUnusable: false,
  })
  assert.equal(reverted.decision, 'revert')
  assert.deepEqual(reverted.regressed, ['T1'])

  const retired = decideSkillChange({
    candidate: [{ id: 'T1', triggerPassed: true, qualityPassed: true }],
    previous: [{ id: 'T1', triggerPassed: true, qualityPassed: true }],
    baseline: [{ id: 'T1', triggerPassed: true, qualityPassed: true }],
    candidateUnusable: false,
  })
  assert.equal(retired.decision, 'retire')
})

test('失败的探测不改父会话提示词,卡片只追加', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-skill-eval-'))
  const parent = 'parent-prompt'
  const pass: SkillEvalObservation = { triggered: true, text: 'ok', paired: true, unavailable: false }
  const first = await evaluateSkillChange({
    cases: [{ id: 'C1', expectTrigger: true, skillName: 'weekly', acceptText: (text) => text === 'ok' }],
    parentSystemPrompt: parent,
    changed: 'weekly@2',
    cardDirectory: directory,
    run: async ({ variant }) => variant === 'baseline'
      ? { triggered: false, text: '', paired: true, unavailable: false }
      : pass,
  })
  assert.equal(first.parentSystemPrompt, parent)
  assert.equal(first.decision, 'adopt')

  const second = await evaluateSkillChange({
    cases: [{ id: 'C1', expectTrigger: true, skillName: 'weekly', acceptText: (text) => text === 'ok' }],
    parentSystemPrompt: parent,
    changed: 'weekly@2',
    cardDirectory: directory,
    run: async ({ variant }) => {
      if (variant === 'candidate') throw new SandboxUnavailableError('sandbox unavailable')
      return pass
    },
  })
  assert.equal(second.parentSystemPrompt, parent)
  assert.equal(second.decision, 'revert')
  const cards = await readEffectCards(directory)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].decision, 'adopt')
  assert.equal(cards[1].decision, 'revert')

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-workspace-'))
  const world = await createLocalWorld({ workspace })
  await assert.rejects(() => world.write(path.join(directory, 'cards.jsonl'), 'nope'))
  const stored = await readFile(path.join(directory, 'cards.jsonl'), 'utf-8')
  assert.equal(stored.trim().split('\n').length, 2)
  await appendEffectCard(directory, cards[0])
  assert.equal((await readEffectCards(directory)).length, 3)
})
