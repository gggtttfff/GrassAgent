import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JsonSafetyError,
  MAX_JSON_DEPTH,
  assertJsonValue,
  jsonTextExceedsDepth,
  jsonValueProblem,
  parseJson,
  stringifyJson,
} from '../../src/core/jsonSafety.ts'

function nestedArrays(depth: number): string {
  return '['.repeat(depth) + '1' + ']'.repeat(depth)
}

function nestedValue(depth: number): unknown {
  let value: unknown = 1
  for (let index = 0; index < depth; index++) value = [value]
  return value
}

test('刚好到上限的数组可以解析,再深一层在解析前拒绝', () => {
  const allowed = parseJson(nestedArrays(MAX_JSON_DEPTH))
  assert.equal(jsonValueProblem(allowed), null)
  assert.equal(stringifyJson(allowed), nestedArrays(MAX_JSON_DEPTH))

  const hostile = nestedArrays(MAX_JSON_DEPTH + 1)
  // 尾巴不是合法 JSON。如果先 parse 再量深度,这里会是 SyntaxError。
  const broken = '['.repeat(MAX_JSON_DEPTH + 1) + 'NOT_JSON'
  assert.throws(() => parseJson(hostile), JsonSafetyError)
  assert.throws(() => parseJson(broken), (error: unknown) => {
    assert.ok(error instanceof JsonSafetyError)
    assert.match((error as Error).message, /拒绝解析/)
    return true
  })
})

test('字符串里的括号不算深度,转义引号也不会提前结束字符串', () => {
  const braces = '{'.repeat(MAX_JSON_DEPTH + 20)
  const text = `{"note":"${braces}"}`
  assert.equal(jsonTextExceedsDepth(text), false)
  assert.deepEqual(parseJson(text), { note: braces })

  const escaped = `{"note":"\\"${braces}"}`
  assert.equal(jsonTextExceedsDepth(escaped), false)
  assert.equal((parseJson(escaped) as { note: string }).note, `"${braces}`)
})

test('内存里的深对象和环在序列化前拒绝,不会沿着环走下去', () => {
  assert.equal(jsonValueProblem(nestedValue(MAX_JSON_DEPTH)), null)
  assert.equal(jsonValueProblem(nestedValue(MAX_JSON_DEPTH + 1)), 'too-deep')
  assert.throws(() => assertJsonValue(nestedValue(MAX_JSON_DEPTH + 1)), /拒绝序列化/)

  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(jsonValueProblem(cyclic), 'circular')
  assert.throws(() => stringifyJson(cyclic), /循环引用/)
})
