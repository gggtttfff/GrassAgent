import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAssistantMessage,
  buildToolResultMessage,
  isMessage,
  normalizeMessage,
  textBlock,
  type ContentBlock,
} from '../../src/llm/messages.ts'

test('assistant 消息包含文本和工具调用', () => {
  const message = buildAssistantMessage('我来看看', [
    { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } },
  ])
  assert.equal(message.role, 'assistant')
  const blocks = message.content as ContentBlock[]
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'tool_use')
})

test('空文本时不产生 text 块', () => {
  const message = buildAssistantMessage('', [{ id: 'c1', name: 'x', args: {} }])
  assert.equal(message.content.length, 1)
})

test('tool_result 消息挂在 user 角色上', () => {
  const message = buildToolResultMessage([
    { tool_use_id: 'call_1', content: '结果A' },
    { tool_use_id: 'call_2', content: '结果B' },
  ])
  assert.equal(message.role, 'user')
  assert.equal(message.content.length, 2)
})

test('字符串内容的消息是合法的', () => {
  assert.equal(isMessage({ role: 'user', content: '你好' }), true)
  assert.equal(isMessage({ role: 'assistant', content: '你好' }), true)
})

test('角色非法的消息被拒绝', () => {
  assert.equal(isMessage({ role: 'system', content: 'x' }), false)
  assert.equal(isMessage({ role: 'tool', content: 'x' }), false)
  assert.equal(isMessage({ content: 'x' }), false)
})

test('内容块结构非法的消息被拒绝', () => {
  assert.equal(isMessage({ role: 'user', content: 123 }), false)
  assert.equal(isMessage({ role: 'user', content: [{ type: 'text' }] }), false)
  assert.equal(isMessage({ role: 'user', content: [{ type: 'unknown' }] }), false)
})

test('tool_use 缺少 id 或 name 时被拒绝', () => {
  assert.equal(isMessage({ role: 'assistant', content: [{ type: 'tool_use', name: 'x' }] }), false)
  assert.equal(isMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }), false)
})

test('tool_result 缺少 tool_use_id 时被拒绝', () => {
  assert.equal(isMessage({ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }), false)
})

test('normalizeMessage 保留完整结构', () => {
  const original = buildAssistantMessage('文本', [{ id: 'c1', name: 'tool', args: { a: 1 } }])
  const normalized = normalizeMessage(original)
  assert.deepEqual(normalized, original)
})

test('normalizeMessage 对非法输入返回 undefined', () => {
  assert.equal(normalizeMessage({ role: 'bad' }), undefined)
  assert.equal(normalizeMessage(null), undefined)
  assert.equal(normalizeMessage('string'), undefined)
})

test('normalizeMessage 归一化字符串内容', () => {
  const normalized = normalizeMessage({ role: 'user', content: 'hello' })
  assert.deepEqual(normalized, { role: 'user', content: 'hello' })
})

test('textBlock 构造文本块', () => {
  assert.deepEqual(textBlock('x'), { type: 'text', text: 'x' })
})
