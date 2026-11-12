import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLogger } from '../../src/core/logger.ts'
import { validateConfig } from '../../src/config.ts'
import { PluginError } from '../../src/plugin/contract.ts'
import { assertRegisteredProviders } from '../../src/plugin/builtinProviders.ts'
import { createPluginHost, registerBuiltinPlugins } from '../../src/plugin/host.ts'
import { loadRuleSection, loadSkillSection } from '../../src/plugin/promptPlugins.ts'
import { createLocalWorld } from '../../src/world/localWorld.ts'

const logger = createLogger({
  level: 'silent',
  format: 'json',
  destination: { write() {} },
})

test('声明的 provider 必须已经显式注册', () => {
  const host = createPluginHost()
  registerBuiltinPlugins(host, { skillEval: false })
  assert.deepEqual(host.contributedProviders(), ['openai'])
  assert.doesNotThrow(() => assertRegisteredProviders(host))
  host.register({
    id: 'grass.llm.missing',
    version: '1.0.0',
    api: 1,
    plane: 'host',
    order: 21,
    failure: 'isolate',
    capabilities: [],
    contributes: { providers: ['missing-provider'] },
  })
  assert.throws(() => assertRegisteredProviders(host), PluginError)
})

test('规则发现抛错时不挡启动', async () => {
  const section = await loadRuleSection({
    enabled: true,
    workspace: os.tmpdir(),
    logger,
    discover: async () => {
      throw new Error('规则文件坏了')
    },
  })
  assert.equal(section.instructionSection, '')
  assert.match(section.instructionReport, /不加载外部规则/)
  assert.equal(section.instructionNotice, section.instructionReport)
})

test('关掉技能加载时不扫描,正文不进索引', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-phase5-'))
  const skillDir = path.join(workspace, '.grass', 'skills', 'demo-phase5')
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: demo-phase5',
    'description: 只该出现在索引里的描述',
    '---',
    'UNIQUE_SKILL_BODY_PHASE5',
    '',
  ].join('\n'))
  const config = validateConfig({
    ApiKey: 'k',
    Workspace: workspace,
    LoadSkills: false,
  })
  const world = await createLocalWorld({ workspace })
  const disabled = await loadSkillSection({ config, world, logger })
  assert.equal(disabled.skills, undefined)
  assert.equal(disabled.skillSection, '')

  const enabled = await loadSkillSection({
    config: validateConfig({ ApiKey: 'k', Workspace: workspace, LoadSkills: true }),
    world,
    logger,
  })
  assert.match(enabled.skillSection, /demo-phase5/)
  assert.equal(enabled.skillSection.includes('UNIQUE_SKILL_BODY_PHASE5'), false)
})
