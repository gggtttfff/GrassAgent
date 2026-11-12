import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  discoverPromptTemplates,
  expandPromptTemplate,
  isUsablePromptCommandName,
  matchPromptTemplate,
} from '../../src/instructions/prompts.ts'

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'grass-prompts-'))
}

async function writeTemplate(workspace: string, name: string, content: string): Promise<void> {
  const directory = path.join(workspace, '.grass', 'prompts')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${name}.md`), content, 'utf8')
}

test('没有提示模板目录时返回空列表', async () => {
  const workspace = await makeWorkspace()
  try {
    assert.deepEqual(await discoverPromptTemplates(workspace), [])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('读出模板的描述和参数提示', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeTemplate(workspace, 'solidify', [
      '---',
      'description: 把结论固化进仓库',
      'argument-hint: "[内容]"',
      '---',
      '请固化:$ARGUMENTS',
    ].join('\n'))

    const templates = await discoverPromptTemplates(workspace)
    assert.equal(templates.length, 1)
    assert.equal(templates[0]?.name, 'solidify')
    assert.equal(templates[0]?.description, '把结论固化进仓库')
    assert.equal(templates[0]?.argumentHint, '[内容]')
    assert.match(templates[0]?.body ?? '', /请固化/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('没有描述时从一级标题取,取不到就跳过', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeTemplate(workspace, 'with-heading', ['# 里程碑存档', '正文。'].join('\n'))
    await writeTemplate(workspace, 'no-description', ['只有正文,没有标题。'].join('\n'))

    const templates = await discoverPromptTemplates(workspace)
    assert.equal(templates.length, 1)
    assert.equal(templates[0]?.name, 'with-heading')
    assert.equal(templates[0]?.description, '里程碑存档')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('$ARGUMENTS 和 $1 都能被替换', () => {
  assert.equal(expandPromptTemplate('目标:$ARGUMENTS', '修好登录'), '目标:修好登录')
  assert.equal(expandPromptTemplate('第一:$1 第二:$2', 'a b'), '第一:a 第二:b')
  // 没有参数时占位符换成空串,不留下痕迹
  assert.equal(expandPromptTemplate('目标:$ARGUMENTS', '  '), '目标:')
  assert.equal(expandPromptTemplate('第一:$1', ''), '第一:')
  // $1 只取第一个词
  assert.equal(expandPromptTemplate('第一:$1', 'a b c'), '第一:a')
})

test('匹配模板命令,只认第一行的斜杠命令', async () => {
  const workspace = await makeWorkspace()
  try {
    await writeTemplate(workspace, 'goal', ['---', 'description: 设定目标', '---', '目标:$ARGUMENTS'].join('\n'))
    const templates = await discoverPromptTemplates(workspace)

    const matched = matchPromptTemplate(templates, '/goal 让测试通过')
    assert.ok(matched)
    assert.equal(matched.template.name, 'goal')
    assert.equal(matched.argument, '让测试通过')
    assert.equal(expandPromptTemplate(matched.template.body, matched.argument), '目标:让测试通过')

    // 不是斜杠开头就不是命令
    assert.equal(matchPromptTemplate(templates, '普通输入'), undefined)
    // 命令名对不上就不匹配
    assert.equal(matchPromptTemplate(templates, '/unknown x'), undefined)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('命令名规则和技能名一致', () => {
  assert.equal(isUsablePromptCommandName('solidify'), true)
  assert.equal(isUsablePromptCommandName('goal-2'), true)
  assert.equal(isUsablePromptCommandName('review/pr'), false)
  assert.equal(isUsablePromptCommandName('带 空格'), false)
  assert.equal(isUsablePromptCommandName('/开头'), false)
})
