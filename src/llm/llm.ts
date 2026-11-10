// src/llm/llm.ts
// LLM 门面 —— 对外保留 stream() 的调用方式,内部按模型选 provider。
//
// 这一层只做三件事:解析 provider、转发调用、注册内置 provider。
// 具体的协议细节(消息转换、SSE 解析)都在 src/llm/providers/ 下,按厂商分文件。

import type { Context } from './messages.ts'
import {
  resolveProvider,
  type Model,
  type Provider,
  type StreamEvent,
  type StreamOptions,
  type ToolDefinition,
} from './protocol.ts'
// 副作用导入:确保内置 provider 已注册
import './providers/index.ts'

export type { Model, Provider, StreamEvent, StreamOptions, ToolDefinition }
export type { Context, Message } from './messages.ts'
export { buildAssistantMessage, buildToolResultMessage } from './messages.ts'

/**
 * 流式调用 LLM。
 * provider 由 model.baseUrl 自动匹配,也可以通过 options.provider 显式指定。
 */
export async function* stream(
  model: Model,
  context: Context,
  options: StreamOptions & { provider?: Provider } = {},
): AsyncGenerator<StreamEvent> {
  const provider = options.provider ?? resolveProvider(model)
  yield* provider.stream(model, context, options)
}
