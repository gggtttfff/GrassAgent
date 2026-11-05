import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextToOpenAIMessages,
  toolDefinitionsToOpenAI,
} from '../src/providers/openai.ts'
import { buildAssistantMessage, buildToolResultMessage } from '../src/messages.ts'
import {
  registerProvider,
  unregisterProvider,
  resolveProvider,
  listProviders,
  type Model,
  type Provider,
  type StreamEvent,
} from '../src/protocol.ts'
import { openAIProvider } from '../src/providers/openai.ts'
// 副作用导入:注册内置 provider,否则 resolveProvider 找不到 openAI
import '../src/providers/index.ts'

const baseModel: Model = { apiKey: 'k', model: 'gpt-4o-mini' }

test('system prompt 转成 system 消息', () => {
  const messages = contextToOpenAIMessages({
    systemPrompt: '你是助手',
    messages: [{ role: 'user', content: '你好' }],
  })
  assert.deepEqual(messages[0], { role: 'system', content: '你是助手' })
  assert.deepEqual(messages[1], { role: 'user', content: '你好' })
})

test('没有 system prompt 时不产生 system 消息', () => {
  const messages = contextToOpenAIMessages({ messages: [{ role: 'user', content: '你好' }] })
  assert.equal(messages.length, 1)
  assert.equal((messages[0] as { role: string }).role, 'user')
})

test('assistant 的工具调用转成 tool_calls', () => {
  const messages = contextToOpenAIMessages({
    messages: [buildAssistantMessage('我来读', [{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }])],
  })
  const assistant = messages[0] as { content: string | null; tool_calls: unknown[] }
  assert.equal(assistant.content, '我来读')
  assert.equal(assistant.tool_calls.length, 1)
  const toolCall = assistant.tool_calls[0] as { id: string; type: string; function: { name: string; arguments: string } }
  assert.equal(toolCall.id, 'call_1')
  assert.equal(toolCall.type, 'function')
  assert.equal(toolCall.function.name, 'read_file')
  assert.equal(toolCall.function.arguments, '{"path":"a.ts"}')
})

test('纯工具调用的 assistant 消息 content 为 null', () => {
  const messages = contextToOpenAIMessages({
    messages: [buildAssistantMessage('', [{ id: 'call_1', name: 'x', args: {} }])],
  })
  const assistant = messages[0] as { content: string | null }
  assert.equal(assistant.content, null)
})

test('空 assistant 消息用空串占位避免 API 400', () => {
  const messages = contextToOpenAIMessages({
    messages: [buildAssistantMessage('', [])],
  })
  const assistant = messages[0] as { content: string | null }
  assert.equal(assistant.content, '')
})

test('tool_result 转成独立的 role:tool 消息', () => {
  const messages = contextToOpenAIMessages({
    messages: [buildToolResultMessage([{ tool_use_id: 'call_1', content: '文件内容' }])],
  })
  const toolMessage = messages[0] as { role: string; tool_call_id: string; content: string }
  assert.equal(toolMessage.role, 'tool')
  assert.equal(toolMessage.tool_call_id, 'call_1')
  assert.equal(toolMessage.content, '文件内容')
})

test('user 消息里的文本块转成 user 消息', () => {
  const messages = contextToOpenAIMessages({
    messages: [{ role: 'user', content: [{ type: 'text', text: '内容' }] }],
  })
  assert.deepEqual(messages[0], { role: 'user', content: '内容' })
})

test('工具定义转成 OpenAI tools 格式', () => {
  const tools = toolDefinitionsToOpenAI([
    { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
  ])
  assert.deepEqual(tools[0], {
    type: 'function',
    function: { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
  })
})

test('openAI provider 匹配任意模型', () => {
  assert.equal(openAIProvider.matches(baseModel), true)
  assert.equal(openAIProvider.matches({ apiKey: 'k', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' }), true)
})

test('自定义 provider 能被注册并解析', async () => {
  const customProvider: Provider = {
    id: 'test-custom',
    matches: (model) => model.model === 'custom-model',
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', stopReason: 'end_turn' }
    },
  }
  registerProvider(customProvider)
  try {
    assert.ok(listProviders().some((provider) => provider.id === 'test-custom'))
    const resolved = resolveProvider({ apiKey: 'k', model: 'custom-model' })
    assert.equal(resolved.id, 'test-custom')
  } finally {
    // 注册表是全局状态,必须清理,否则会污染后续用例
    unregisterProvider('test-custom')
  }
})

test('精确匹配的 provider 优先于兜底 provider', () => {
  const customProvider: Provider = {
    id: 'test-priority',
    matches: (model) => model.model === 'custom-model',
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', stopReason: 'end_turn' }
    },
  }
  registerProvider(customProvider)
  try {
    // openAI 是兜底 provider,不该抢走精确匹配的活
    assert.equal(resolveProvider({ apiKey: 'k', model: 'custom-model' }).id, 'test-priority')
    // 没有精确匹配时由兜底接管
    assert.equal(resolveProvider(baseModel).id, 'openai')
  } finally {
    unregisterProvider('test-priority')
  }
})

test('注销 provider 后不再被解析到', () => {
  const temporary: Provider = {
    id: 'test-temporary',
    matches: () => true,
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', stopReason: 'end_turn' }
    },
  }
  registerProvider(temporary)
  assert.equal(resolveProvider(baseModel).id, 'test-temporary')

  unregisterProvider('test-temporary')
  assert.equal(resolveProvider(baseModel).id, 'openai')
})
