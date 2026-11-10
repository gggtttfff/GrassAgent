import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  discoverProjectInstructions,
  type InstructionLog,
} from '../src/projectInstructions.ts'

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'grass-rules-'))
}

function captureLog(): InstructionLog & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    warn(_object, message) {
      warnings.push(message)
    },
    info() {},
  }
}

test('认出四家工具的规则和提示词,并且不把提示词整篇塞进上下文', async () => {
  const workspace = await makeWorkspace()
  const log = captureLog()
  try {
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), '共享约定:先写测试。')
    await fs.writeFile(path.join(workspace, 'CLAUDE.md'), 'Claude 约定:保持接口兼容。')
    await fs.mkdir(path.join(workspace, 'services', 'api'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'services', 'api', 'AGENTS.md'), '只在这个服务里用。')

    await fs.mkdir(path.join(workspace, '.cursor', 'rules'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.cursor', 'rules', 'always.mdc'), [
      '---',
      'alwaysApply: true',
      'description: 提交',
      '---',
      '提交说明用中文。',
    ].join('\n'))
    await fs.writeFile(path.join(workspace, '.cursor', 'rules', 'api.mdc'), [
      '---',
      'alwaysApply: false',
      'globs: src/**/*.ts',
      '---',
      '接口字段只能加不能改。',
    ].join('\n'))
    await fs.writeFile(path.join(workspace, '.cursor', 'rules', 'notes.md'), '这不是规则。')
    await fs.mkdir(path.join(workspace, '.cursor', 'commands'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.cursor', 'commands', 'pr.md'), '按仓库模板写 PR。')
    await fs.writeFile(path.join(workspace, '.cursorrules'), '旧版光标规则。')

    await fs.mkdir(path.join(workspace, '.claude', 'rules'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.claude', 'rules', 'style.md'), '用四个空格。')
    await fs.writeFile(path.join(workspace, '.claude', 'rules', 'python.md'), [
      '---',
      'paths:',
      '  - "src/**/*.py"',
      '---',
      '用 pytest。',
    ].join('\n'))
    await fs.mkdir(path.join(workspace, '.claude', 'commands'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.claude', 'commands', 'optimize.md'), '只优化热点。')
    await fs.mkdir(path.join(workspace, '.claude', 'skills', 'review'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.claude', 'skills', 'review', 'SKILL.md'), [
      '---',
      'name: review',
      'description: 审查改动',
      '---',
      '按严重程度列问题。',
    ].join('\n'))

    await fs.mkdir(path.join(workspace, '.kiro', 'steering'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.kiro', 'steering', 'product.md'), '# 产品\n做一棵能走的小草。')
    await fs.writeFile(path.join(workspace, '.kiro', 'steering', 'go.md'), [
      '---',
      'inclusion: fileMatch',
      'fileMatchPattern: "**/*.go"',
      '---',
      '错误要包装。',
    ].join('\n'))
    await fs.writeFile(path.join(workspace, '.kiro', 'steering', 'manual.md'), [
      '---',
      'inclusion: manual',
      '---',
      '只有点名才用的转向。',
    ].join('\n'))
    await fs.mkdir(path.join(workspace, '.kiro', 'agents'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.kiro', 'agents', 'reviewer.json'), JSON.stringify({
      name: 'reviewer',
      description: '审查',
      prompt: '你是审查员,不要改文件。',
    }))

    await fs.mkdir(path.join(workspace, '.opencode', 'commands'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.opencode', 'commands', 'test.md'), '跑全部测试。')
    await fs.writeFile(path.join(workspace, 'CONTRIBUTING.md'), '贡献先开 issue。')
    await fs.writeFile(path.join(workspace, 'opencode.jsonc'), [
      '{',
      '  // 团队约定',
      '  "instructions": ["CONTRIBUTING.md", "https://example.com/rules.md", "../outside.md"],',
      '  "command": {',
      '    "ship": {',
      '      "description": "发版",',
      '      "template": "写发布说明"',
      '    }',
      '  },',
      '  "agents": {',
      '    "reviewer": {',
      '      "description": "审查",',
      '      "system": "只报告问题"',
      '    }',
      '  }',
      '}',
    ].join('\n'))

    await fs.mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'node_modules', 'pkg', 'AGENTS.md'), '依赖里的秘密规则。')

    const catalog = await discoverProjectInstructions(workspace, log)
    const section = catalog.promptSection

    assert.match(section, /共享约定:先写测试/)
    assert.match(section, /Claude 约定:保持接口兼容/)
    assert.match(section, /提交说明用中文/)
    assert.match(section, /旧版光标规则/)
    assert.match(section, /用四个空格/)
    assert.match(section, /做一棵能走的小草/)
    assert.match(section, /贡献先开 issue/)

    assert.equal(section.includes('接口字段只能加不能改'), false)
    assert.equal(section.includes('这不是规则'), false)
    assert.equal(section.includes('按仓库模板写 PR'), false)
    assert.equal(section.includes('用 pytest'), false)
    assert.equal(section.includes('只优化热点'), false)
    assert.equal(section.includes('按严重程度列问题'), false)
    assert.equal(section.includes('错误要包装'), false)
    assert.equal(section.includes('只有点名才用的转向'), false)
    assert.equal(section.includes('你是审查员,不要改文件'), false)
    assert.equal(section.includes('跑全部测试'), false)
    assert.equal(section.includes('写发布说明'), false)
    assert.equal(section.includes('只报告问题'), false)
    assert.equal(section.includes('只在这个服务里用'), false)
    assert.equal(section.includes('依赖里的秘密规则'), false)

    const agents = catalog.instructions.find((item) => item.relativePath === 'AGENTS.md')
    assert.deepEqual(agents?.tools, ['opencode', 'cursor', 'claude', 'kiro'])
    assert.equal(agents?.activation, 'always')

    const nested = catalog.instructions.find((item) => item.relativePath === 'services/api/AGENTS.md')
    assert.equal(nested?.activation, 'file-match')
    assert.equal(nested?.includedBody, undefined)

    const cursorCommand = catalog.instructions.find((item) => item.relativePath === '.cursor/commands/pr.md')
    assert.equal(cursorCommand?.kind, 'prompt')
    assert.equal(cursorCommand?.title, '/pr')

    const opencodeCommand = catalog.instructions.find((item) => item.title === '/test')
    assert.equal(opencodeCommand?.tools.includes('opencode'), true)

    const ship = catalog.instructions.find((item) => item.title === '/ship')
    assert.equal(ship?.relativePath, 'opencode.jsonc')
    assert.match(ship?.description ?? '', /发版/)

    // 技能归 skills.ts 管(要能被 load_skill 按名字取正文),这里不再重复列成提示词
    assert.equal(
      catalog.instructions.some((item) => item.relativePath === '.claude/skills/review/SKILL.md'),
      false,
    )

    assert.equal(catalog.instructions.some((item) => item.relativePath.includes('node_modules')), false)
    assert.equal(catalog.instructions.some((item) => item.relativePath === '.cursor/rules/notes.md'), false)
    assert.ok(log.warnings.some((message) => message.includes('远程规则不抓取')))
    assert.ok(log.warnings.some((message) => message.includes('工作区外')))
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('软链指向工作区外的规则不读', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-link-'))
  const workspace = path.join(root, 'project')
  const outside = path.join(root, 'outside.md')
  try {
    await fs.mkdir(workspace)
    await fs.writeFile(outside, 'OUTSIDE SECRET')
    await fs.symlink(outside, path.join(workspace, 'AGENTS.md'))
    const catalog = await discoverProjectInstructions(workspace, captureLog())
    assert.equal(catalog.promptSection.includes('OUTSIDE SECRET'), false)
    assert.equal(catalog.instructions.some((item) => item.relativePath === 'AGENTS.md'), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('单文件过长或合计过长时只留索引', async () => {
  const workspace = await makeWorkspace()
  try {
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'A'.repeat(13_000))
    await fs.writeFile(path.join(workspace, 'CLAUDE.md'), 'C'.repeat(7_000))
    await fs.writeFile(path.join(workspace, '.cursorrules'), 'R'.repeat(7_000))
    await fs.mkdir(path.join(workspace, '.kiro', 'steering'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.kiro', 'steering', 'product.md'), 'K'.repeat(7_000))
    await fs.writeFile(path.join(workspace, 'CONTRIBUTING.md'), 'N'.repeat(7_000))
    await fs.writeFile(path.join(workspace, 'opencode.json'), JSON.stringify({
      instructions: ['CONTRIBUTING.md'],
    }))

    const catalog = await discoverProjectInstructions(workspace)
    const agents = catalog.instructions.find((item) => item.relativePath === 'AGENTS.md')
    assert.match(agents?.omittedReason ?? '', /单文件超过/)
    assert.equal(catalog.promptSection.includes('A'.repeat(100)), false)

    const included = catalog.instructions.filter((item) => item.includedBody).map((item) => item.relativePath)
    assert.deepEqual(included, ['CLAUDE.md', '.cursorrules', '.kiro/steering/product.md'])
    const contributing = catalog.instructions.find((item) => item.relativePath === 'CONTRIBUTING.md')
    assert.match(contributing?.omittedReason ?? '', /合计超过/)
    assert.equal(catalog.promptSection.includes('N'.repeat(100)), false)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('注释里的括号不算深度,真正嵌套过深的配置只记日志', async () => {
  const workspace = await makeWorkspace()
  const log = captureLog()
  try {
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), '根规则还在。')
    await fs.writeFile(path.join(workspace, 'opencode.jsonc'), [
      `/* ${'{'.repeat(400)} */`,
      '{ "command": { "keep": { "description": "留下", "template": "注释里的括号不算" } } }',
    ].join('\n'))
    await fs.writeFile(
      path.join(workspace, 'opencode.json'),
      `{"instructions":${'['.repeat(400)}"AGENTS.md"${']'.repeat(400)}}`,
    )
    await fs.mkdir(path.join(workspace, '.kiro', 'agents'), { recursive: true })
    await fs.writeFile(
      path.join(workspace, '.kiro', 'agents', 'deep.json'),
      '['.repeat(400) + '1' + ']'.repeat(400),
    )

    const catalog = await discoverProjectInstructions(workspace, log)
    assert.match(catalog.promptSection, /根规则还在/)
    const kept = catalog.instructions.find((item) => item.title === '/keep')
    assert.equal(kept?.relativePath, 'opencode.jsonc')
    assert.equal(log.warnings.some((warning) => warning.includes('嵌套')), true)
    assert.equal(catalog.instructions.some((item) => item.relativePath.endsWith('deep.json')), false)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

test('空目录不会编出一段规则', async () => {
  const workspace = await makeWorkspace()
  try {
    const catalog = await discoverProjectInstructions(workspace)
    assert.equal(catalog.instructions.length, 0)
    assert.equal(catalog.promptSection, '')
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})
