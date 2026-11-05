// src/providers/openai.ts
// OpenAI 兼容 provider —— 覆盖 OpenAI / DeepSeek / Ollama / vLLM 等所有
// 实现了 /chat/completions 且 SSE 格式一致的服务。
//
// SSE 流解析的约束(踩过坑才留下的):
// tool_call 的参数是分片增量拼接的 partial JSON,只能在流结束时统一解析。
// 解析中途执行会拿到半个 JSON。

import type { Context } from '../messages.ts'
import {
  type Model,
  type Provider,
  type StreamEvent,
  type StreamOptions,
  type ToolDefinition,
} from '../protocol.ts'
import { createTransport } from '../transport.ts'
import type { Logger } from '../logger.ts'

// OpenAI sse chunk 的最小类型
interface OpenAIChunk {
  choices: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
}

// 累积中的工具调用
interface ToolCallBuffer {
  id: string
  name: string
  argsBuf: string
}

/**
 * 把内部 Context 转成 OpenAI 的 messages 数组。
 *
 * 这是 provider 专属的转换,内部消息模型不会泄漏到协议层。
 */
export function contextToOpenAIMessages(context: Context): object[] {
  const messages: object[] = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })

  for (const message of context.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content })
      continue
    }

    const blocks = message.content
    if (message.role === 'assistant') {
      const toolCalls: object[] = []
      let text = ''
      for (const block of blocks) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          })
        }
      }
      // OpenAI 要求 assistant 消息必须有 content(非 null)或 tool_calls
      // 纯 tool_call 时 content 为 null;两者皆空(如 abort/error 后的内容无轮次) 用空串占位,避免 API 400
      const content = text || (toolCalls.length ? null : '')
      messages.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined })
    } else {
      // user message 里的 tool_result block -> OpenAI 要求独立的 role:tool 消息
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
        } else if (block.type === 'text') {
          messages.push({ role: 'user', content: block.text })
        }
      }
    }
  }

  return messages
}

// 把内部工具定义转成 OpenAI 的 tools 数组
export function toolDefinitionsToOpenAI(tools: ToolDefinition[]): object[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/**
 * 解析一行 SSE data,累积 tool_call,返回文本增量和停止原因。
 */
function handleSSELine(
  data: string,
  toolCallBuffers: Map<number, ToolCallBuffer>,
): { textDelta: string | null; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null } {
  let chunk: OpenAIChunk
  try {
    chunk = JSON.parse(data) as OpenAIChunk
  } catch {
    return { textDelta: null, stopReason: null }
  }

  const choice = chunk.choices[0]
  if (!choice) return { textDelta: null, stopReason: null }

  let textDelta: string | null = null
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = null

  if (choice.delta?.content) textDelta = choice.delta.content

  // tool_call 增量:按 index 累计 name + arguments 的 partial JSON
  if (choice.delta?.tool_calls) {
    for (const toolCall of choice.delta.tool_calls) {
      const index = toolCall.index ?? 0
      if (!toolCallBuffers.has(index)) {
        toolCallBuffers.set(index, { id: toolCall.id ?? `call_${index}`, name: '', argsBuf: '' })
      }
      const entry = toolCallBuffers.get(index)!
      if (toolCall.id) entry.id = toolCall.id
      if (toolCall.function?.name) entry.name = toolCall.function.name
      if (toolCall.function?.arguments) entry.argsBuf += toolCall.function.arguments
    }
  }

  // finish_reason 映射:tool_calls->tool_use,length->max_tokens,其余->end_turn
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens'
  else stopReason = 'end_turn'

  return { textDelta, stopReason }
}

/**
 * 流结束时把累积的 tool_calls 按顺序发出。
 * argsBuf 解析失败时不静默回退成 {}:空对象会让工具拿到 undefined 参数执行。
 * 用 argsInvalid 标记,由 agent 层跳过执行并把错误回填给模型重发。
 */
function flushToolCalls(
  toolCallBuffers: Map<number, ToolCallBuffer>,
): { id: string; name: string; args: unknown; argsInvalid: boolean }[] {
  const calls: { id: string; name: string; args: unknown; argsInvalid: boolean }[] = []
  for (const [, toolCall] of [...toolCallBuffers].sort((a, b) => a[0] - b[0])) {
    let args: unknown = {}
    // 有 argsBuf 但解析不出对象,说明模型给的 JSON 损坏(如被 max_tokens 截断)
    let argsInvalid = false
    if (toolCall.argsBuf) {
      try {
        args = JSON.parse(toolCall.argsBuf)
      } catch {
        argsInvalid = true
      }
    }
    calls.push({ id: toolCall.id, name: toolCall.name, args, argsInvalid })
  }
  return calls
}

// OpenAI 兼容 provider 实现
export const openAIProvider: Provider = {
  id: 'openai',

  // 兜底 provider:没有更精确的 provider 匹配时才接管。
  // OpenAI 兼容协议是事实标准,但它能连的端点太多了,
  // 不标成兜底的话会抢走专门 provider 的活。
  fallback: true,

  matches(): boolean {
    return true
  },

  async *stream(model: Model, context: Context, options: StreamOptions): AsyncGenerator<StreamEvent> {
    const url = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
    const messages = contextToOpenAIMessages(context)

    const body: Record<string, unknown> = { model: model.model, stream: true, messages }
    if (model.maxTokens) body.max_tokens = model.maxTokens
    if (options.tools?.length) body.tools = toolDefinitionsToOpenAI(options.tools)

    // 传输层负责超时/重试/并发,provider 层只关心拿到响应流
    const transport = options.transport ?? createTransport({
      timeoutMs: 120_000,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30_000,
      maxConcurrency: 4,
      logger: options.logger,
    })

    // 发请求
    let response: Response
    try {
      response = await transport.request(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
          body: JSON.stringify(body),
        },
        { signal: options.signal, operationName: 'chat.completions' },
      )
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
      yield { type: 'error', error: error as Error }
      return
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => 'unknown error')
      yield { type: 'error', error: new Error(`API ${response.status}: ${text}`) }
      return
    }

    // 逐行解析 SSE
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
    const toolCallBuffers = new Map<number, ToolCallBuffer>()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          const result = handleSSELine(data, toolCallBuffers)
          if (result.textDelta) yield { type: 'text_delta', delta: result.textDelta }
          if (result.stopReason) stopReason = result.stopReason
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
      yield { type: 'error', error: error as Error }
      return
    }

    // 发出累积的 tool_calls
    for (const toolCall of flushToolCalls(toolCallBuffers)) {
      yield {
        type: 'tool_call',
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        argsInvalid: toolCall.argsInvalid,
      }
    }

    yield { type: 'done', stopReason: options.signal?.aborted ? 'aborted' : stopReason }
  },
}
