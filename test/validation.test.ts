import { test } from 'node:test'
import assert from 'node:assert/strict'
import { obj, str, num, opt, bool } from '@earendil-works/pi-schema'
import { validateToolArguments, checkToolArguments } from '../src/validation.ts'

const schema = obj({
  path: str({ description: '文件路径' }),
  count: num(),
  flag: opt(bool()),
})

test('合法参数通过校验', () => {
  const result = validateToolArguments(schema, { path: 'a.ts', count: 1 }, 'test_tool')
  assert.equal(result.ok, true)
})

test('字符串数字被自动转换成数字', () => {
  const result = validateToolArguments(schema, { path: 'a.ts', count: '42' }, 'test_tool')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal((result.value as { count: number }).count, 42)
  }
})

test('数字被自动转换成字符串', () => {
  const result = validateToolArguments(schema, { path: 123, count: 1 }, 'test_tool')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal((result.value as { path: string }).path, '123')
  }
})

test('可选参数的 null 被丢弃', () => {
  const result = validateToolArguments(schema, { path: 'a.ts', count: 1, flag: null }, 'test_tool')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal('flag' in (result.value as object), false)
  }
})

test('缺少必填字段时校验失败', () => {
  const result = validateToolArguments(schema, { count: 1 }, 'test_tool')
  assert.equal(result.ok, false)
})

test('类型无法转换时校验失败', () => {
  const result = validateToolArguments(schema, { path: 'a.ts', count: 'abc' }, 'test_tool')
  assert.equal(result.ok, false)
})

test('多余的字段被拒绝', () => {
  const result = validateToolArguments(schema, { path: 'a.ts', count: 1, extra: 'x' }, 'test_tool')
  assert.equal(result.ok, false)
})

test('错误信息包含工具名和出错路径', () => {
  const result = validateToolArguments(schema, { path: 'a.ts', count: 'abc' }, 'my_tool')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.error.includes('my_tool'), `实际: ${result.error}`)
    assert.ok(result.error.includes('count'), `实际: ${result.error}`)
  }
})

test('错误信息包含收到的原始参数', () => {
  const result = validateToolArguments(schema, { path: 'a.ts', count: 'abc' }, 'my_tool')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.error.includes('abc'), `实际: ${result.error}`)
  }
})

test('校验通过时 checkToolArguments 返回 undefined', () => {
  assert.equal(checkToolArguments(schema, { path: 'a.ts', count: 1 }, 'test_tool'), undefined)
})

test('校验失败时 checkToolArguments 返回错误文本', () => {
  const error = checkToolArguments(schema, { path: 'a.ts', count: 'abc' }, 'test_tool')
  assert.ok(typeof error === 'string')
  assert.ok(error.includes('参数校验失败'))
})

test('原始参数不被校验过程修改', () => {
  const original = { path: 'a.ts', count: '42' }
  validateToolArguments(schema, original, 'test_tool')
  assert.equal(original.count, '42', '校验不应修改调用方的对象')
})

test('嵌套对象的错误路径是点号形式', () => {
  const nestedSchema = obj({
    edits: obj({
      oldText: str(),
    }),
  })
  // 缺内层必填字段才会失败:数字会被 coerce 成字符串救回来
  const result = validateToolArguments(nestedSchema, { edits: {} }, 'test_tool')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.error.includes('edits.oldText'), `实际: ${result.error}`)
  }
})
