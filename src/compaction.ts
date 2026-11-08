// src/compaction.ts
// 上下文压缩 —— 决定「发给模型看哪一段」,不改写会话历史。
//
// 为什么历史和视图要分开:
//
// 改写历史会砍掉消息,带来两个后果:
//
// 1. tool_use 和 tool_result 被切点劈开。发出去的是一条孤零零的
//    role:tool 消息,前面没有对应的 tool_calls,OpenAI 侧直接 400。
// 2. 会话存储按「新增条数」增量写。历史被砍之后新增消息写不进去,
//    那一整段对话就凭空消失了。
//
// 所以这里维持两样东西:
//   - 历史(context.messages):单调增长,永远完整,存进数据库的也是它
//   - 视图(buildModelContext):摘要 + 保留区,只影响这一次请求
//
// 切点还有个约束:不能落在工具调用和它的结果之间。
// findSafeBoundary 负责找一条安全的切线。

import type { Context, CompactionState, Message } from './messages.ts'
import type { Model } from './protocol.ts'
import { stream, type StreamOptions } from './llm.ts'
import type { Transport } from './transport.ts'
import type { Logger } from './logger.ts'

/** 压缩配置 */
export interface CompactionOptions {
  /** 未压缩的消息数超过这个值就触发压缩 */
  threshold: number
  /** 压缩时保留最近这么多条消息 */
  keepRecent: number
}

/** 摘要消息的前缀。模型靠它认出「这是压缩过的上下文」 */
const SUMMARY_PREFIX = '[context summary]'

// 摘要用的提示词。要点是保留「决策」和「待办」,不是复述对话。
const SUMMARY_PROMPT =
  '请将以下对话总结为简洁的上下文摘要,保留关键决策,已做的工作和待办事项。'

/**
 * 保留区里有没有落单的 tool_result。
 *
 * 落单 = 找不到对应的 tool_use。发出去就是一条没有来由的 role:tool 消息。
 */
export function hasOrphanToolResult(messages: Message[]): boolean {
  const toolUseIds = new Set<string>()
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
    }
  }
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type === 'tool_result' && !toolUseIds.has(block.tool_use_id)) {
        return true
      }
    }
  }
  return false
}

/**
 * 找一条安全的切点。
 *
 * 切点落在 tool_use 和它的 tool_result 之间时,两边各留一半,API 会 400。
 * 遇到这种切点就把切点往前挪,让这对调用一起留在保留区。
 *
 * 挪动的判据是「保留区里有没有落单的 tool_result」——
 * 直接对着结果本身判断,不用猜配对关系。
 */
export function findSafeBoundary(messages: Message[], targetIndex: number): number {
  let index = Math.max(0, Math.min(targetIndex, messages.length))
  while (index > 0 && hasOrphanToolResult(messages.slice(index))) {
    index -= 1
  }
  return index
}

// 把一条消息拍平成纯文本,给模型总结用。
function flattenMessage(message: Message): string {
  if (typeof message.content === 'string') {
    return `${message.role}:${message.content}`
  }
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'tool_use') {
      parts.push(`[调用工具 ${block.name}] ${JSON.stringify(block.input)}`)
    } else {
      parts.push(`[工具结果] ${block.content}`)
    }
  }
  return `${message.role}:${parts.join('\n')}`
}

/**
 * 构造发给模型的视图:摘要 + 保留区。
 *
 * 没有压缩过就原样返回——绝大多数回合走的是这条路径。
 */
export function buildModelMessages(
  context: Context,
  compaction: CompactionState | null | undefined,
): Message[] {
  if (!compaction) return context.messages
  return [
    { role: 'user', content: `${SUMMARY_PREFIX}\n${compaction.summary}` },
    ...context.messages.slice(compaction.summarizedCount),
  ]
}

/**
 * 构造发给模型的完整上下文(含系统提示词)。
 *
 * 历史在 context.messages 里原样保留,这里只换掉 messages 的部分。
 */
export function buildModelContext(
  context: Context,
  compaction: CompactionState | null | undefined,
): Context {
  return {
    systemPrompt: context.systemPrompt,
    messages: buildModelMessages(context, compaction),
  }
}

/**
 * 压缩旧消息,把结果写回 context.compaction。
 *
 * 只在「还没被摘要覆盖的部分」变长时才会真的压缩。
 * 已经摘要过的历史不会再发一遍,否则模型会看到同一段对话的多个版本。
 *
 * 压缩失败时不动任何消息——
 * 宁可多发点上下文,也不能用空摘要把会话毁掉。
 */
export async function compactContext(
  model: Model,
  context: Context,
  signal: AbortSignal | undefined,
  options: { transport?: Transport; logger?: Logger } = {},
  compactionOptions: CompactionOptions,
): Promise<void> {
  // abort 时不压缩,省一次请求也避免半截摘要
  if (signal?.aborted) return

  const compaction = context.compaction
  const summarizedCount = compaction?.summarizedCount ?? 0
  const liveCount = context.messages.length - summarizedCount
  if (liveCount < compactionOptions.threshold) return

  // 切点:保留最近 keepRecent 条,再保证不劈开工具调用和结果
  const targetBoundary = context.messages.length - compactionOptions.keepRecent
  const boundary = findSafeBoundary(context.messages, targetBoundary)
  // 切点没往前进就没有新东西可摘要,别空转
  if (boundary <= summarizedCount) return

  const newMessages = context.messages.slice(summarizedCount, boundary)

  // 上一次的摘要要带上:这轮总结的是「旧摘要 + 新增消息」,
  // 只总结新增的部分会把之前压缩掉的历史弄丢。
  const previousSummary = compaction?.summary
  const conversationText = [
    ...(previousSummary ? [`[之前的摘要]\n${previousSummary}`] : []),
    ...newMessages.map(flattenMessage),
  ].join('\n')

  // 用一轮额外的调用做总结,不走工具
  const summaryContext: Context = {
    systemPrompt: SUMMARY_PROMPT,
    messages: [{ role: 'user', content: conversationText }],
  }

  let summary = ''
  let failed = false
  const summaryOptions: StreamOptions = { signal, transport: options.transport, logger: options.logger }
  for await (const event of stream(model, summaryContext, summaryOptions)) {
    if (event.type === 'text_delta') {
      summary += event.delta
    } else if (event.type === 'error' || (event.type === 'done' && event.stopReason === 'aborted')) {
      failed = true
      break
    }
  }

  // 兜底:压缩失败就保持原样,不用空摘要替换
  if (failed || !summary.trim()) {
    options.logger?.warn(
      {
        summarizedCount,
        boundary,
        liveCount,
        reason: failed ? '请求失败' : '摘要为空',
      },
      '上下文压缩失败,保留原始消息',
    )
    return
  }

  options.logger?.info(
    { summarizedCount, boundary, liveCount, summaryLength: summary.length },
    '上下文已压缩',
  )

  context.compaction = { summarizedCount: boundary, summary }
}
