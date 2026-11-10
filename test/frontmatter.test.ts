import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitFrontmatter, parseFrontmatterYaml } from '../src/frontmatter.ts'

test('标量、列表和折叠块都能解析', () => {
  const { data, body, bodyStartLine } = splitFrontmatter([
    '---',
    'name: demo',
    'count: 3',
    'enabled: true',
    'tags:',
    '  - a',
    '  - b',
    'description: >-',
    '  第一句,',
    '  第二句。',
    '---',
    '正文。',
  ].join('\n'))

  assert.equal(data.name, 'demo')
  assert.equal(data.count, '3')
  assert.equal(data.enabled, true)
  assert.deepEqual(data.tags, ['a', 'b'])
  assert.equal(data.description, '第一句, 第二句。')
  assert.equal(body, '正文。')
  // 正文第一行在文件里的行号
  assert.equal(bodyStartLine, 12)
})

test('竖线块保留换行', () => {
  const { data } = splitFrontmatter([
    '---',
    'description: |',
    '  第一行',
    '  第二行',
    '---',
    '正文。',
  ].join('\n'))
  assert.equal(data.description, '第一行\n第二行')
})

test('嵌套一层映射能解析', () => {
  const { data } = splitFrontmatter([
    '---',
    'name: demo',
    'metadata:',
    '  surfaces:',
    '    - cli',
    '  version: 2',
    '---',
    '正文。',
  ].join('\n'))

  const metadata = data.metadata
  assert.equal(typeof metadata, 'object')
  assert.equal(Array.isArray(metadata), false)
  assert.deepEqual((metadata as Record<string, unknown>).surfaces, ['cli'])
  assert.equal((metadata as Record<string, unknown>).version, '2')
})

test('没有 frontmatter 时整篇是正文', () => {
  const { data, body, bodyStartLine } = splitFrontmatter('正文第一行\n正文第二行')
  assert.deepEqual(data, {})
  assert.equal(body, '正文第一行\n正文第二行')
  assert.equal(bodyStartLine, 1)
})

test('坏行跳过,不影响其它字段', () => {
  const data = parseFrontmatterYaml([
    'name: demo',
    '这不是字段',
    'description: 还在',
  ].join('\n'))
  assert.equal(data.name, 'demo')
  assert.equal(data.description, '还在')
})

test('收尾的 --- 缺失时整篇当正文', () => {
  const { data, body } = splitFrontmatter('---\nname: demo\n没有收尾')
  assert.deepEqual(data, {})
  assert.equal(body.includes('没有收尾'), true)
})
