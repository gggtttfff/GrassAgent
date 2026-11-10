// src/llm/protocol.ts
// Provider 协议 —— 定义「一个 LLM 后端」需要提供什么。
//
// 抽象出这一层的意义:agent 循环、上下文压缩、工具调度都不再关心
// 底层是 OpenAI 兼容、Anthropic 还是本地模型。加新 provider = 实现这个接口 + 注册。

import type { Context } from './messages.ts'
import type { Transport } from '../core/transport.ts'
import type { Logger } from '../core/logger.ts'

/** 模型配置(provider 无关的部分) */
export interface Model {
  apiKey: string
  model: string
  baseUrl?: string
  maxTokens?: number
}

/** 工具定义:发给模型看的名字、描述、参数 schema */
export interface ToolDefinition {
  name: string
  description: string
  parameters: object
}

/** 流事件:provider 统一输出 */
export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown; argsInvalid: boolean }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }
  | { type: 'error'; error: Error }

/** 调用参数 */
export interface StreamOptions {
  tools?: ToolDefinition[]
  signal?: AbortSignal
  transport?: Transport
  logger?: Logger
}

/**
 * Provider 协议。
 *
 * 契约:
 * - 必须把内部 Context 转换成自己的协议格式,不得把内部结构泄露到协议层
 * - 遇到不可恢复的错误要 yield {type:'error'},不要直接抛异常打断调用方
 * - abort 要 yield {type:'done', stopReason:'aborted'},由调用方决定怎么收尾
 */
export interface Provider {
  /** provider 标识,如 'openai' */
  readonly id: string
  /** 是否支持这个 baseUrl。用于按地址自动选择 provider */
  matches(model: Model): boolean
  /**
   * 是否是兜底 provider。
   * 兜底 provider(如 OpenAI 兼容协议)在没有更精确的匹配时接管。
   * 不设这个标记的 provider 优先级更高,与注册顺序无关。
   */
  readonly fallback?: boolean
  /** 流式调用,产出统一事件 */
  stream(model: Model, context: Context, options: StreamOptions): AsyncGenerator<StreamEvent>
}

// provider 注册表。
const providers: Provider[] = []

/** 注册一个 provider */
export function registerProvider(provider: Provider): void {
  providers.push(provider)
}

/** 注销一个 provider。主要给测试用,避免注册状态跨用例泄漏 */
export function unregisterProvider(providerId: string): void {
  const index = providers.findIndex((provider) => provider.id === providerId)
  if (index >= 0) providers.splice(index, 1)
}

/** 取出已注册的 provider 列表 */
export function listProviders(): readonly Provider[] {
  return providers
}

/**
 * 找到能处理这个模型的 provider。
 *
 * 优先级:非兜底 provider 优先,注册顺序在同优先级内生效。
 * 这样 OpenAI 兼容协议虽然兜底,也不会抢走专门 provider 的活。
 *
 * 找不到就抛错,并把所有已注册的 provider 列出来,方便排查配置问题。
 */
export function resolveProvider(model: Model): Provider {
  // 第一轮:精确匹配
  for (const provider of providers) {
    if (!provider.fallback && provider.matches(model)) return provider
  }
  // 第二轮:兜底匹配
  for (const provider of providers) {
    if (provider.fallback && provider.matches(model)) return provider
  }
  const available = providers.map((provider) => provider.id).join(', ') || '（无）'
  throw new Error(`找不到能处理 ${model.model} 的 provider,已注册: ${available}`)
}
