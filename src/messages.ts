// src/messages.ts
// 内部消息模型 —— provider 无关。
//
// 分层的意义:内部表示不绑定任何一家厂商的协议。
// 只有在真正发请求的边界(见 src/providers/)才转成 OpenAI/Anthropic 等格式。
// 这样加一个新 provider 只需要写一个转换器,不用改 agent 循环和上下文管理。

/** 内容块:文本 */
export interface TextBlock {
  type: 'text'
  text: string
}

/** 内容块:工具调用请求 */
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/** 内容块:工具执行结果 */
export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

/** 消息角色 */
export type MessageRole = 'user' | 'assistant'

/** 一条消息 */
export interface Message {
  role: MessageRole
  content: string | ContentBlock[]
}

/**
 * 上下文压缩状态。
 *
 * 压缩不改写历史,只标记「前多少条已经被摘要覆盖」。
 * 历史本身始终完整——它是会话存储的内容,也是 /resume 恢复出来的内容。
 */
export interface CompactionState {
  /** 已经被摘要覆盖的消息条数 */
  summarizedCount: number
  /** 摘要正文。文件清单不放在这里,避免下一轮合并摘要时把路径重复写进正文。 */
  summary: string
  /** 被摘要覆盖的历史里读过的文件,跨次压缩累加 */
  readFiles?: string[]
  /** 被摘要覆盖的历史里改过的文件,跨次压缩累加 */
  modifiedFiles?: string[]
}

/** 上下文:系统提示词 + 消息列表 + 压缩状态 */
export interface Context {
  systemPrompt?: string
  messages: Message[]
  /**
   * 压缩状态。还没压缩过就不设。
   *
   * 放在 Context 里是因为它要跨回合存活:
   * 压缩过的历史不该在下一轮又原样发一遍。
   */
  compaction?: CompactionState
}

/** 构造文本块 */
export function textBlock(text: string): TextBlock {
  return { type: 'text', text }
}

/** 构造 assistant 消息:文本 + 工具调用 */
export function buildAssistantMessage(
  text: string,
  toolCalls: { id: string; name: string; args: unknown }[],
): Message {
  const content: ContentBlock[] = []
  if (text) content.push(textBlock(text))
  for (const toolCall of toolCalls) {
    content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.args })
  }
  return { role: 'assistant', content }
}

/** 构造 tool_result 消息 */
export function buildToolResultMessage(
  results: { tool_use_id: string; content: string }[],
): Message {
  return {
    role: 'user',
    content: results.map((result) => ({
      type: 'tool_result' as const,
      tool_use_id: result.tool_use_id,
      content: result.content,
    })),
  }
}

// 会话记录的兼容处理。
// 早期版本用 JSONL 文件存会话,结构一样但字段名可能不一致
// (比如 content 数组里的 tool_use 叫 name/input,tool_result 叫 tool_use_id)。
// 这里做一次归一化,坏数据宁可跳过也不要让整个会话加载失败。

/** 判断一条已解析的 JSON 是否是可用的 Message */
export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { role?: unknown; content?: unknown }
  if (candidate.role !== 'user' && candidate.role !== 'assistant') return false
  if (typeof candidate.content === 'string') return true
  if (!Array.isArray(candidate.content)) return false
  // 内容块数组:每一块都要有已知类型,未知类型直接判为不可用
  return candidate.content.every((block) => {
    if (!block || typeof block !== 'object') return false
    const type = (block as { type?: unknown }).type
    if (type === 'text') return typeof (block as { text?: unknown }).text === 'string'
    if (type === 'tool_use') {
      const toolUse = block as { id?: unknown; name?: unknown }
      return typeof toolUse.id === 'string' && typeof toolUse.name === 'string'
    }
    if (type === 'tool_result') {
      const toolResult = block as { tool_use_id?: unknown; content?: unknown }
      return typeof toolResult.tool_use_id === 'string' && typeof toolResult.content === 'string'
    }
    return false
  })
}

/** 把任意已解析的 JSON 归一化成 Message,失败返回 undefined */
export function normalizeMessage(value: unknown): Message | undefined {
  if (!isMessage(value)) return undefined
  const candidate = value as Message
  if (typeof candidate.content === 'string') {
    return { role: candidate.role, content: candidate.content }
  }
  return {
    role: candidate.role,
    content: candidate.content.map((block): ContentBlock => {
      if (block.type === 'text') return textBlock(block.text)
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      }
      return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content }
    }),
  }
}

function toolUseIds(message: Message): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content.filter((block) => block.type === 'tool_use').map((block) => block.id)
}

function toolResultIds(message: Message): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.tool_use_id)
}

/**
 * 每个 tool_use 都要有配对的 tool_result,中间不能插入别的消息。
 * 配不上对的会话发回 API 会 400,导入这种会话等于把坏数据写进库。
 */
export function messagesArePaired(messages: Message[]): boolean {
  const pending = new Set<string>()
  for (const message of messages) {
    const uses = toolUseIds(message)
    const results = toolResultIds(message)
    // 同一条消息里又发起又回收,配对关系说不清
    if (uses.length > 0 && results.length > 0) return false
    for (const id of results) {
      if (!pending.has(id)) return false
      pending.delete(id)
    }
    // 还有没回收的工具调用时,普通文本会把配对劈开
    if (uses.length === 0 && results.length === 0 && pending.size > 0) return false
    if (uses.length > 0 && pending.size > 0) return false
    for (const id of uses) {
      if (pending.has(id)) return false
      pending.add(id)
    }
  }
  return pending.size === 0
}
