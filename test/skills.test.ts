import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createSkillRegistry,
  discoverSkills,
  type SkillLog,
} from '../src/skills.ts'
import { builtinTools } from '../src/tools.ts'

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'grass-skills-'))
}

interface CapturedLog extends SkillLog {
  warnings: string[]
}

function captureLog(): CapturedLog {
  const warnings: string[] = []
  return {
    warnings,
    warn(_object, message) {
      warnings.push(message)
    },
    info() {},
  }
}

async function writeSkill(
  workspace: string,
  relativeDirectory: string,
  content: string,
): Promise<void> {
  const directory = path.join(workspace, relativeDirectory)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'SKILL.md'), content)
}

test('技能只把名字和描述放进索引,正文留给 load_skill', async () => {
  const workspace = await makeWorkspace()
  const log = captureLog()
  try {
    await writeSkill(workspace, '.grass/skills/demo', [
      '---',
      'name: demo',
      'description: 演示用的技能',
      '---',
      '# Demo',
      '正文里才有具体步骤。',
    ].join('\n'))

    const catalog = await discoverSkills(workspace, log)
    assert.equal(catalog.skills.length, 1)
    const skill = catalog.skills[0]
    assert.equal(skill?.name, 'demo')
    assert.equal(skill?.description, '演示用的技能')
    assert.equal(skill?.relativePath, '.grass/skills/demo/SKILL.md')
    assert.equal(skill?.directoryPath, '.grass/skills/demo')
    assert.equal(skill?.source, 'grass')
    assert.equal(skill?.truncated, false)
    assert.match(skill?.body ?? '', /正文里才有具体步骤/)

    // 索引里有名字和描述,不能有正文
    assert.match(catalog.promptSection, /demo: 演示用的技能/)
    assert.equal(catalog.promptSection.includes('正文里才有具体步骤'), false)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('Cursor 那种 >- 折叠描述能解析成一句话', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.cursor/skills/agent-builder', [
      '---',
      'name: agent-builder',
      'description: >-',
      '  Scaffold a new agent: short interview,',
      '  then verify a turn. Ask only what the',
      '  message left open.',
      '---',
      '按 interview 的结论搭骨架。',
    ].join('\n'))

    const catalog = await discoverSkills(workspace)
    assert.equal(
      catalog.skills[0]?.description,
      'Scaffold a new agent: short interview, then verify a turn. Ask only what the message left open.',
    )
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('同名技能按根的顺序取第一个,并记下被忽略的那个', async () => {
  const workspace = await makeWorkspace()
  const log = captureLog()
  try {
    await writeSkill(workspace, '.grass/skills/review', [
      '---',
      'name: review',
      'description: 自己的审查流程',
      '---',
      '工作区自己的做法。',
    ].join('\n'))
    await writeSkill(workspace, '.cursor/skills/review', [
      '---',
      'name: review',
      'description: cursor 的审查流程',
      '---',
      'cursor 的做法。',
    ].join('\n'))

    const catalog = await discoverSkills(workspace, log)
    assert.equal(catalog.skills.length, 1)
    assert.equal(catalog.skills[0]?.source, 'grass')
    assert.equal(catalog.skills[0]?.description, '自己的审查流程')
    assert.ok(log.warnings.some((message) => message.includes('技能名重复')))
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('没有名字的技能用目录名,没有描述又不能从标题补的跳过', async () => {
  const workspace = await makeWorkspace()
  const log = captureLog()
  try {
    await writeSkill(workspace, '.grass/skills/no-name', '---\ndescription: 用目录名当名字\n---\n正文。')
    await writeSkill(workspace, '.claude/skills/no-description', '---\nname: no-description\n---\n正文,没写描述也没有标题。')
    await writeSkill(workspace, '.kiro/skills/from-heading', '---\nname: from-heading\n---\n# 从标题取描述\n正文。')

    const catalog = await discoverSkills(workspace, log)
    const names = catalog.skills.map((skill) => skill.name).sort()
    assert.deepEqual(names, ['from-heading', 'no-name'])
    assert.equal(
      catalog.skills.find((skill) => skill.name === 'from-heading')?.description,
      '从标题取描述',
    )
    assert.ok(log.warnings.some((message) => message.includes('技能没有描述')))
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('正文过长时截断,并提示用 read_file 读全文', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/long', [
      '---',
      'name: long',
      'description: 很长的技能',
      '---',
      'x'.repeat(25_000),
    ].join('\n'))

    const catalog = await discoverSkills(workspace)
    assert.equal(catalog.skills[0]?.truncated, true)
    const tools = await builtinTools({ workspace, skills: createSkillRegistry(catalog.skills) })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')
    const result = await loadSkill?.execute({ name: 'long' })
    assert.match(result ?? '', /已截断/)
    assert.match(result ?? '', /read_file 读 \.grass\/skills\/long\/SKILL\.md/)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('load_skill 返回正文和附件目录,未知名字报错时列出可用技能', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/demo', [
      '---',
      'name: demo',
      'description: 演示用的技能',
      '---',
      '第一步读 scripts/run.sh。',
    ].join('\n'))

    const catalog = await discoverSkills(workspace)
    const tools = await builtinTools({ workspace, skills: createSkillRegistry(catalog.skills) })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')
    assert.ok(loadSkill)

    const result = await loadSkill.execute({ name: '/DEMO' })
    assert.match(result, /# 技能 demo/)
    assert.match(result, /附件目录:\.grass\/skills\/demo/)
    assert.match(result, /第一步读 scripts\/run\.sh/)

    const missing = await loadSkill.execute({ name: 'nope' })
    assert.match(missing, /没有名为 "nope" 的技能/)
    assert.match(missing, /可用技能:demo/)

    const blank = await loadSkill.execute({ name: '   ' })
    assert.match(blank, /name 不能为空/)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('一个技能都没有时不注册 load_skill', async () => {
  const workspace = await makeWorkspace()
  try {
    const catalog = await discoverSkills(workspace)
    assert.equal(catalog.skills.length, 0)
    assert.equal(catalog.promptSection, '')

    const withoutRegistry = await builtinTools({ workspace })
    assert.equal(withoutRegistry.some((tool) => tool.name === 'load_skill'), false)

    const emptyRegistry = await builtinTools({ workspace, skills: createSkillRegistry([]) })
    assert.equal(emptyRegistry.some((tool) => tool.name === 'load_skill'), false)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})