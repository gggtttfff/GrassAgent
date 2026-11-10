import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  commandOnlySkills,
  createLocalSkillFiles,
  createSkillCache,
  createSkillRegistry,
  createWorldSkillFiles,
  describeDisabledSkills,
  discoverSkills,
  formatCommandOnlySkill,
  isUsableCommandName,
  SKILL_CACHE_RELATIVE_PATH,
  type SkillLog,
  type SkillOrigin,
} from '../src/skills.ts'
import { builtinTools } from '../src/tools.ts'
import type { ApprovalGate } from '../src/approvalGate.ts'
import { validateConfig } from '../src/config.ts'
import { createInProcessBackend } from '../src/sandbox/inProcessBackend.ts'
import { createControlPlane, type TimerFn } from '../src/sandbox/control.ts'
import { listenControl } from '../src/sandbox/controlHttp.ts'
import { openExecutionWorld } from '../src/sandbox/openWorld.ts'

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'grass-skills-'))
}

const localOrigin: SkillOrigin = { kind: 'local', label: '本地工作区' }
const idleTimer: TimerFn = () => ({ refresh() {}, cancel() {} })

// 默认审批是拒绝,测正文内容时得显式放行
const allowAll: ApprovalGate = { decide: async () => 'allow' }

/** 本地工作区上的技能扫描,免得每个用例都写一遍组装。 */
async function scanLocalSkills(
  workspace: string,
  logger?: SkillLog,
): Promise<Awaited<ReturnType<typeof discoverSkills>>> {
  return discoverSkills({
    files: await createLocalSkillFiles(workspace),
    origin: localOrigin,
    logger,
  })
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

    const catalog = await scanLocalSkills(workspace, log)
    assert.equal(catalog.skills.length, 1)
    const skill = catalog.skills[0]
    assert.equal(skill?.name, 'demo')
    assert.equal(skill?.description, '演示用的技能')
    assert.equal(skill?.relativePath, '.grass/skills/demo/SKILL.md')
    assert.equal(skill?.directoryPath, '.grass/skills/demo')
    assert.equal(skill?.source, 'grass')
    assert.equal(skill?.truncated, false)
    assert.match(skill?.body ?? '', /正文里才有具体步骤/)

    // 索引里有名字、来源和描述,不能有正文
    assert.match(catalog.promptSection, /demo\(来源:本地工作区\): 演示用的技能/)
    assert.equal(catalog.promptSection.includes('正文里才有具体步骤'), false)
    assert.equal(skill?.origin.kind, 'local')
    assert.equal(skill?.origin.label, '本地工作区')
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

    const catalog = await scanLocalSkills(workspace)
    assert.equal(
      catalog.skills[0]?.description,
      'Scaffold a new agent: short interview, then verify a turn. Ask only what the message left open.',
    )
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('同名技能全部禁用,并说明各自的来源和路径', async () => {
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

    const catalog = await scanLocalSkills(workspace, log)
    assert.equal(catalog.skills.length, 2)
    // 两份都在,但都被禁用
    for (const skill of catalog.skills) {
      assert.match(skill.disabledReason ?? '', /存在 2 个同名技能/)
      assert.match(skill.disabledReason ?? '', /\.grass\/skills\/review/)
      assert.match(skill.disabledReason ?? '', /\.cursor\/skills\/review/)
    }
    // 禁用之后不进索引,模型也取不到
    assert.equal(catalog.promptSection, '')
    const registry = createSkillRegistry(catalog.skills)
    assert.equal(registry.names().length, 0)
    assert.equal(registry.find('review'), undefined)
    assert.ok(log.warnings.some((message) => message.includes('同名技能已全部禁用')))

    const notices = describeDisabledSkills(catalog.skills)
    assert.equal(notices.length, 2)
    assert.match(notices[0] ?? '', /技能 review 已禁用/)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('大小写不同的同名技能也算冲突', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/Review', [
      '---',
      'name: Review',
      'description: 大写的那个',
      '---',
      '正文。',
    ].join('\n'))
    await writeSkill(workspace, '.cursor/skills/review', [
      '---',
      'name: review',
      'description: 小写的那个',
      '---',
      '正文。',
    ].join('\n'))

    const catalog = await scanLocalSkills(workspace)
    assert.equal(catalog.skills.every((skill) => Boolean(skill.disabledReason)), true)
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

    const catalog = await scanLocalSkills(workspace, log)
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

    const catalog = await scanLocalSkills(workspace)
    assert.equal(catalog.skills[0]?.truncated, true)
    const tools = await builtinTools({ workspace, skills: createSkillRegistry(catalog.skills), approval: allowAll })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')
    const result = await loadSkill?.execute({ names: ['long'] })
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

    const catalog = await scanLocalSkills(workspace)
    const tools = await builtinTools({ workspace, skills: createSkillRegistry(catalog.skills), approval: allowAll })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')
    assert.ok(loadSkill)

    const result = await loadSkill.execute({ names: ['/DEMO'] })
    assert.match(result, /# 技能 demo/)
    assert.match(result, /附件目录:\.grass\/skills\/demo/)
    // 正文里的相对路径是相对技能目录的,不是工作区根
    assert.match(result, /相对路径都相对于 \.grass\/skills\/demo/)
    assert.match(result, /第一步读 scripts\/run\.sh/)

    const missing = await loadSkill.execute({ names: ['nope'] })
    assert.match(missing, /没有名为 "nope" 的技能/)
    assert.match(missing, /可用技能:demo/)

    const blank = await loadSkill.execute({ names: ['   '] })
    assert.match(blank, /names 不能为空/)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('远程世界的技能从沙盒里读,来源标出主机', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-skills-remote-'))
  try {
    const backend = createInProcessBackend({ stateDir })
    const plane = createControlPlane({ backend, timer: idleTimer })
    const listening = await listenControl(plane)
    try {
      const config = validateConfig({
        ApiKey: 'sk-test',
        ExecutionWorld: 'remote',
        SandboxControlUrl: listening.url,
        SandboxImage: 'test-image',
        Workspace: stateDir,
      })
      const world = await openExecutionWorld(config, { sessionId: 'session-skills' })
      await world.write(
        '.grass/skills/demo/SKILL.md',
        ['---', 'name: demo', 'description: 远程的技能', '---', '远程正文。'].join('\n'),
      )

      const origin: SkillOrigin = { kind: 'remote', label: '远程 user@host:22' }
      const catalog = await discoverSkills({
        files: createWorldSkillFiles(world),
        origin,
      })
      assert.equal(catalog.skills.length, 1)
      assert.equal(catalog.skills[0]?.name, 'demo')
      assert.equal(catalog.skills[0]?.origin.kind, 'remote')
      assert.equal(catalog.skills[0]?.origin.label, '远程 user@host:22')
      assert.equal(catalog.skills[0]?.body, '远程正文。')
      assert.match(catalog.promptSection, /demo\(来源:远程 user@host:22\)/)
    } finally {
      await listening.close().catch(() => undefined)
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true })
  }
})

test('缓存命中时不重读文件,文件变了就失效', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/demo', [
      '---',
      'name: demo',
      'description: 演示用的技能',
      '---',
      '正文。',
    ].join('\n'))

    const cache = createSkillCache({
      workspace,
      relativePath: SKILL_CACHE_RELATIVE_PATH,
    })
    const first = await discoverSkills({
      files: await createLocalSkillFiles(workspace),
      origin: localOrigin,
      cache,
    })
    assert.equal(first.skills.length, 1)
    // 缓存文件已经落盘
    assert.equal(
      await fs.stat(path.join(workspace, SKILL_CACHE_RELATIVE_PATH)).then(() => true),
      true,
    )

    // 第二次扫描:把读文件的通道掐掉,还能扫出技能就说明走了缓存
    const files = await createLocalSkillFiles(workspace)
    const brokenRead: typeof files.readText = async () => undefined
    const cached = await discoverSkills({
      files: { listEntries: files.listEntries, readText: brokenRead },
      origin: localOrigin,
      cache,
    })
    assert.equal(cached.skills.length, 1)
    assert.equal(cached.skills[0]?.name, 'demo')

    // 文件改了,缓存失效,重新读
    await writeSkill(workspace, '.grass/skills/demo', [
      '---',
      'name: demo',
      'description: 改过的描述',
      '---',
      '新正文。',
    ].join('\n'))
    const refreshed = await discoverSkills({
      files: await createLocalSkillFiles(workspace),
      origin: localOrigin,
      cache,
    })
    assert.equal(refreshed.skills[0]?.description, '改过的描述')
    assert.equal(refreshed.skills[0]?.body, '新正文。')
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('缓存文件坏了当没有缓存', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/demo', [
      '---',
      'name: demo',
      'description: 演示用的技能',
      '---',
      '正文。',
    ].join('\n'))
    await fs.mkdir(path.join(workspace, '.grass', 'tmp'), { recursive: true })
    await fs.writeFile(path.join(workspace, SKILL_CACHE_RELATIVE_PATH), '{ 坏的 json')

    const cache = createSkillCache({ workspace, relativePath: SKILL_CACHE_RELATIVE_PATH })
    const catalog = await discoverSkills({
      files: await createLocalSkillFiles(workspace),
      origin: localOrigin,
      cache,
    })
    assert.equal(catalog.skills.length, 1)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('环境不匹配的技能被跳过,匹配的留下', async () => {
  const workspace = await makeWorkspace()
  const log = captureLog()
  try {
    await writeSkill(workspace, '.grass/skills/cloud-only', [
      '---',
      'name: cloud-only',
      'description: 只在云端跑',
      'environments:',
      '  - cloud',
      '---',
      '正文。',
    ].join('\n'))
    await writeSkill(workspace, '.grass/skills/not-here', [
      '---',
      'name: not-here',
      'description: 本地禁用',
      'disabled-environments:',
      '  - local',
      '---',
      '正文。',
    ].join('\n'))
    await writeSkill(workspace, '.grass/skills/ide-only', [
      '---',
      'name: ide-only',
      'description: 只在 IDE 里',
      'metadata:',
      '  surfaces:',
      '    - ide',
      '---',
      '正文。',
    ].join('\n'))
    await writeSkill(workspace, '.grass/skills/local-ok', [
      '---',
      'name: local-ok',
      'description: 本地能用',
      'environments:',
      '  - local',
      '  - cloud',
      'metadata:',
      '  surfaces:',
      '    - cli',
      '---',
      '正文。',
    ].join('\n'))

    const catalog = await scanLocalSkills(workspace, log)
    const usable = catalog.skills.filter((skill) => !skill.skippedReason).map((skill) => skill.name)
    assert.deepEqual(usable, ['local-ok'])
    assert.match(catalog.skills.find((skill) => skill.name === 'cloud-only')?.skippedReason ?? '', /只在 cloud 环境可用/)
    assert.match(catalog.skills.find((skill) => skill.name === 'not-here')?.skippedReason ?? '', /local 环境被显式禁用/)
    assert.match(catalog.skills.find((skill) => skill.name === 'ide-only')?.skippedReason ?? '', /只在 ide 界面可用/)

    // 跳过的技能不进索引,模型也取不到
    assert.equal(catalog.promptSection.includes('cloud-only'), false)
    assert.equal(createSkillRegistry(catalog.skills).find('cloud-only'), undefined)
    assert.ok(log.warnings.some((message) => message.includes('技能环境不匹配')))
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('描述按句子边界截断,索引里标出被截断', async () => {
  const workspace = await makeWorkspace()
  try {
    const longDescription = `${'这是一句很长的描述。'.repeat(20)}最后一句。`
    await writeSkill(workspace, '.grass/skills/wordy', [
      '---',
      'name: wordy',
      `description: ${longDescription}`,
      '---',
      '正文。',
    ].join('\n'))

    const catalog = await scanLocalSkills(workspace)
    const skill = catalog.skills[0]
    assert.equal(skill?.descriptionClipped, true)
    assert.ok((skill?.description.length ?? 0) <= 201)
    // 截在句子边界上,不是句子中间
    assert.match(skill?.description ?? '', /。…$/)
    assert.match(catalog.promptSection, /描述已截断/)

    await writeSkill(workspace, '.grass/skills/short', [
      '---',
      'name: short',
      'description: 很短',
      '---',
      '正文。',
    ].join('\n'))
    const withShort = await scanLocalSkills(workspace)
    assert.equal(withShort.skills.find((item) => item.name === 'short')?.descriptionClipped, false)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('标题清单带文件行号,截断时仍覆盖全文', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/long', [
      '---',
      'name: long',
      'description: 分节的技能',
      '---',
      '## 第一节',
      '内容一。',
      '## 第二节',
      '内容二。',
      '## 第三节',
      'x'.repeat(25_000),
    ].join('\n'))

    const catalog = await scanLocalSkills(workspace)
    const skill = catalog.skills[0]
    assert.deepEqual(skill?.headings.map((heading) => heading.title), ['第一节', '第二节', '第三节'])
    // 行号按整个 SKILL.md 算,read_file 对得上
    assert.equal(skill?.headings[0]?.line, 5)
    assert.equal(skill?.headings[1]?.line, 7)

    const tools = await builtinTools({ workspace, skills: createSkillRegistry(catalog.skills), approval: allowAll })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')
    const result = await loadSkill?.execute({ names: ['long'] })
    assert.match(result ?? '', /目录:/)
    assert.match(result ?? '', /第一节\(第 5 行\)/)
    // 截断了,目录仍要覆盖全文
    assert.match(result ?? '', /第三节\(第 9 行\)/)
    assert.match(result ?? '', /上面的目录覆盖全文/)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('附件列在技能目录里,超大和超量的不进清单', async () => {
  const workspace = await makeWorkspace()
  try {
    const skillDirectory = path.join(workspace, '.grass', 'skills', 'demo')
    await fs.mkdir(skillDirectory, { recursive: true })
    await fs.writeFile(
      path.join(skillDirectory, 'SKILL.md'),
      ['---', 'name: demo', 'description: 带附件的技能', '---', '正文。'].join('\n'),
    )
    await fs.writeFile(path.join(skillDirectory, 'run.sh'), 'echo hi')
    await fs.writeFile(path.join(skillDirectory, 'notes.md'), '说明')
    await fs.writeFile(path.join(skillDirectory, 'huge.bin'), Buffer.alloc(300 * 1024))

    const catalog = await scanLocalSkills(workspace)
    const skill = catalog.skills[0]
    assert.deepEqual(skill?.attachments, [
      '.grass/skills/demo/notes.md',
      '.grass/skills/demo/run.sh',
    ])

    const tools = await builtinTools({ workspace, skills: createSkillRegistry(catalog.skills), approval: allowAll })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')
    const result = await loadSkill?.execute({ names: ['demo'] })
    assert.match(result ?? '', /附件:\.grass\/skills\/demo\/notes\.md、\.grass\/skills\/demo\/run\.sh/)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('只读技能不进索引,注册成斜杠命令', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/shell', [
      '---',
      'name: shell',
      'description: 把后面的文本当命令跑',
      'disable-model-invocation: true',
      '---',
      '把后面的文本原样当 shell 命令执行。',
    ].join('\n'))

    const catalog = await scanLocalSkills(workspace)
    const skill = catalog.skills[0]
    assert.equal(skill?.commandOnly, true)
    // 不进索引,模型也调不到
    assert.equal(catalog.promptSection, '')
    assert.equal(createSkillRegistry(catalog.skills).find('shell'), undefined)

    assert.equal(commandOnlySkills(catalog.skills).length, 1)
    const text = formatCommandOnlySkill(skill!, 'ls -la')
    assert.match(text, /把后面的文本原样当 shell 命令执行/)
    assert.match(text, /参数:ls -la/)
    assert.match(text, /只显示给你/)

    assert.equal(isUsableCommandName('shell'), true)
    assert.equal(isUsableCommandName('review/pr'), false)
    assert.equal(isUsableCommandName('带 空格'), false)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('一次能加载多个技能,重复的名字只加载一次', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/first', [
      '---', 'name: first', 'description: 第一个', '---', '正文一。',
    ].join('\n'))
    await writeSkill(workspace, '.grass/skills/second', [
      '---', 'name: second', 'description: 第二个', '---', '正文二。',
    ].join('\n'))

    const catalog = await scanLocalSkills(workspace)
    const tools = await builtinTools({ workspace, skills: createSkillRegistry(catalog.skills), approval: allowAll })
    const loadSkill = tools.find((tool) => tool.name === 'load_skill')
    assert.ok(loadSkill)

    const result = await loadSkill.execute({ names: ['first', 'second'] })
    assert.match(result, /# 技能 first/)
    assert.match(result, /# 技能 second/)
    assert.match(result, /正文一。/)
    assert.match(result, /正文二。/)

    const repeated = await loadSkill.execute({ names: ['first', 'first'] })
    assert.equal(repeated.match(/# 技能 first/g)?.length, 1)

    // 已知和未知的混在一起:已知的照样给出来
    const mixed = await loadSkill.execute({ names: ['first', 'nope'] })
    assert.match(mixed, /# 技能 first/)
    assert.match(mixed, /没有名为 "nope" 的技能/)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('加载技能前要过审批,拒绝就不给正文', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeSkill(workspace, '.grass/skills/demo', [
      '---', 'name: demo', 'description: 演示用的技能', '---', '正文内容。',
    ].join('\n'))

    const catalog = await scanLocalSkills(workspace)
    const registry = createSkillRegistry(catalog.skills)

    const allowing: ApprovalGate = { decide: async () => 'allow' }
    const denying: ApprovalGate = { decide: async () => 'deny' }
    const unavailable: ApprovalGate = { decide: async () => 'unavailable' }

    const allowed = await builtinTools({ workspace, skills: registry, approval: allowing })
    const allowedResult = await allowed.find((tool) => tool.name === 'load_skill')?.execute({ names: ['demo'] })
    assert.match(allowedResult ?? '', /正文内容。/)

    const denied = await builtinTools({ workspace, skills: registry, approval: denying })
    const deniedResult = await denied.find((tool) => tool.name === 'load_skill')?.execute({ names: ['demo'] })
    assert.match(deniedResult ?? '', /审批拒绝加载技能/)
    assert.match(deniedResult ?? '', /不要再次请求/)
    assert.equal((deniedResult ?? '').includes('正文内容。'), false, '拒绝时不能给出正文')

    const unreachable = await builtinTools({ workspace, skills: registry, approval: unavailable })
    const unreachableResult = await unreachable.find((tool) => tool.name === 'load_skill')?.execute({ names: ['demo'] })
    assert.match(unreachableResult ?? '', /审批拒绝加载技能/)

    // 没有审批门就是拒绝:没人能点头就不给正文
    const noGate = await builtinTools({ workspace, skills: registry })
    const noGateResult = await noGate.find((tool) => tool.name === 'load_skill')?.execute({ names: ['demo'] })
    assert.match(noGateResult ?? '', /审批拒绝加载技能/)
    assert.equal((noGateResult ?? '').includes('正文内容。'), false)

    // 审批要独占输入通道
    assert.equal(noGate.find((tool) => tool.name === 'load_skill')?.sequential, true)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('一个技能都没有时不注册 load_skill', async () => {
  const workspace = await makeWorkspace()
  try {
    const catalog = await scanLocalSkills(workspace)
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