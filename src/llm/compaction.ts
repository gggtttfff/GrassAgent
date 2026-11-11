// src/llm/compaction.ts
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
//
// 触发和保留按估算 token,不按消息条数。一条工具输出可以比几十条短消息更占窗口。
// 估算用字符数 / 4,和 pi 一样:不引分词器,偏保守(实际 token 通常更少)。
// 摘要用固定结构,文件路径不靠模型回忆——从被压掉的 tool_use 里抽出来附在摘要后面。

import { JsonSafetyError, stringifyJson } from '../core/jsonSafety.ts'
import type { Context, CompactionState, Message } from './messages.ts'
import type { Model } from './protocol.ts'
import type { StreamOptions } from './llm.ts'
import { completeText } from './completeText.ts'
import type { Transport } from '../core/transport.ts'
import type { Logger } from '../core/logger.ts'

// 这些默认值和 src/config.ts 里的 schema 默认值是同一组。
// config 不能反向依赖这里,所以数字写了两处。改的时候两处一起改。
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_COMPACT_RESERVE_TOKENS = 16_384
export const DEFAULT_COMPACT_KEEP_RECENT_TOKENS = 20_000

/** 压缩配置。触发线是窗口减去预留,保留区按 token 从尾部回切。 */
export interface CompactionOptions {
  /** 模型上下文窗口(token)。只用来决定什么时候该压,不是 API 参数。 */
  contextWindow: number
  /** 窗口里留给回复和摘要的 token。超过 window - reserve 就开始压。 */
  reserveTokens: number
  /** 压缩后尽量留下的最近 token 数。 */
  keepRecentTokens: number
}

/** 摘要消息的前缀。模型靠它认出「这是压缩过的上下文」 */
const SUMMARY_PREFIX = '[context summary]'

// 摘要请求自己就是一次性的。系统提示词把模型钉在「只输出摘要」上,
// 否则它会接着回答对话里的问题,摘要里就混进新的回复。
const SUMMARY_SYSTEM_PROMPT =
  '你是上下文摘要助手。阅读一段用户和助手的对话,只按指定格式输出结构化摘要。不要继续对话,不要回答对话里的问题。'

const SUMMARY_FORMAT = `严格使用这个格式:

## 目标
[用户要完成什么。一件事写一条,可以有多条]

## 约束与偏好
- [用户提过的限制、偏好、要求]
- [没有就写「（无）」]

## 进展
### 已完成
- [x] [已经做完的事]

### 进行中
- [ ] [正在做的事]

### 受阻
- [卡住的问题。没有就写「（无）」]

## 关键决定
- **[决定]**: [简短理由]

## 下一步
1. [接下来按顺序该做什么]

## 关键上下文
- [接着干活必须知道的数据、例子、报错原文]
- [没有就写「（无）」]

每一节都短。保留准确的文件路径、函数名和报错原文。不要自己编文件清单,路径由系统另外附上。`

const SUMMARY_PROMPT =
  `上面的对话需要总结成上下文检查点,另一段模型会靠它接着干活。\n\n${SUMMARY_FORMAT}`

const UPDATE_SUMMARY_PROMPT =
  `上面是新的对话,标签里是已有摘要。把新信息合并进摘要。规则:
- 保留已有摘要里的信息
- 补上新的进展、决定和上下文
- 做完的事从「进行中」挪到「已完成」
- 按当前状态改「下一步」
- 不再相关的可以删

${SUMMARY_FORMAT}`

const READ_TOOL_NAMES = new Set(['read_file'])
const MODIFY_TOOL_NAMES = new Set(['write_file', 'edit', 'edit_batch'])

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

function jsonLength(value: unknown): number {
  try {
    // 不要直接 JSON.stringify。过深的参数会在递归里把栈打穿,catch 也接不住干净。
    return stringifyJson(value)?.length ?? 0
  } catch {
    return 0
  }
}

function messageChars(message: Message): number {
  if (typeof message.content === 'string') return message.content.length
  let chars = 0
  for (const block of message.content) {
    if (block.type === 'text') chars += block.text.length
    else if (block.type === 'tool_use') chars += block.name.length + jsonLength(block.input)
    else chars += block.content.length
  }
  return chars
}

/**
 * 估算一条消息的 token。
 *
 * 字符数 / 4 再向上取整。中文实际更密,取整是为了早一点压,而不是把窗口撑满再发现。
 */
export function estimateMessageTokens(message: Message): number {
  return Math.ceil(messageChars(message) / 4)
}

/** 估算一组消息的 token,逐条取整后再相加,和单条估算的口径一致。 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/**
 * 从尾部回走,留下大约 keepRecentTokens。
 *
 * 返回值是保留区的起点。整段都放得下就返回 startIndex,表示没有新东西可切。
 * 切到 tool_result 上时再交给 findSafeBoundary 往前挪,避免把配对劈开。
 * 往前挪会多留几条,保留区可以略大于预算,但不能为了卡预算把工具结果拆出去。
 */
export function findTokenCut(messages: Message[], startIndex: number, keepRecentTokens: number): number {
  let accumulated = 0
  for (let index = messages.length - 1; index >= startIndex; index--) {
    accumulated += estimateMessageTokens(messages[index])
    if (accumulated >= keepRecentTokens) return findSafeBoundary(messages, index)
  }
  return startIndex
}

function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const pathValue = (input as { path?: unknown }).path
  return typeof pathValue === 'string' && pathValue ? pathValue : undefined
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const filePath of paths) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    unique.push(filePath)
  }
  return unique
}

/**
 * 从工具调用里抽出读过和改过的路径。
 *
 * 不让摘要模型自己回忆路径:它会漏,漏了下一轮就不知道哪些文件已经看过。
 */
export function collectFileOperations(messages: Message[]): { readFiles: string[]; modifiedFiles: string[] } {
  const readFiles: string[] = []
  const modifiedFiles: string[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      const filePath = toolPath(block.input)
      if (!filePath) continue
      if (READ_TOOL_NAMES.has(block.name)) readFiles.push(filePath)
      else if (MODIFY_TOOL_NAMES.has(block.name)) modifiedFiles.push(filePath)
    }
  }
  return { readFiles: uniquePaths(readFiles), modifiedFiles: uniquePaths(modifiedFiles) }
}

function mergePaths(previous: string[] | undefined, current: string[]): string[] {
  return uniquePaths([...(previous ?? []), ...current])
}

function formatFileLists(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = []
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`)
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`)
  return sections.join('\n\n')
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
      parts.push(`[调用工具 ${block.name}] ${flattenToolInput(block.input)}`)
    } else {
      parts.push(`[工具结果] ${block.content}`)
    }
  }
  return `${message.role}:${parts.join('\n')}`
}

function flattenToolInput(input: unknown): string {
  try {
    return stringifyJson(input)
  } catch (error) {
    // 摘要只是给人看的文本。过深的参数省略掉,不要在压缩时把栈打穿。
    if (error instanceof JsonSafetyError) return '[参数嵌套过深,已省略]'
    throw error
  }
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
  if (!compaction || compaction.summarizedCount <= 0 || !compaction.summary.trim()) {
    return context.messages
  }
  const fileLists = formatFileLists(compaction.readFiles ?? [], compaction.modifiedFiles ?? [])
  const summary = fileLists ? `${compaction.summary}\n\n${fileLists}` : compaction.summary
  return [
    { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` },
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
 * 这一轮会不会真的去压缩。
 *
 * 判据和 compactContext 的前两道门槛相同:视图超过「窗口 - 预留」,
 * 并且切点还能往前挪出一段可摘要的消息。
 * PreCompact 钩子只在这时才跑。每轮都跑的话,拦截压缩的命令会在普通回合里空转。
 */
export function compactionPending(context: Context, compactionOptions: CompactionOptions): boolean {
  const summarizedCount = context.compaction?.summarizedCount ?? 0
  const viewTokens = estimateMessagesTokens(buildModelMessages(context, context.compaction))
  const tokenBudget = compactionOptions.contextWindow - compactionOptions.reserveTokens
  if (viewTokens <= tokenBudget) return false
  const boundary = findTokenCut(context.messages, summarizedCount, compactionOptions.keepRecentTokens)
  return boundary > summarizedCount
}

/**
 * 压缩旧消息,把结果写回 context.compaction。
 *
 * 只在发给模型的视图超过「窗口 - 预留」时才会真的压缩。
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
  // 看的是即将发给模型的视图,不是完整历史。已经压掉的部分不该再把阈值撑满。
  const viewTokens = estimateMessagesTokens(buildModelMessages(context, compaction))
  const tokenBudget = compactionOptions.contextWindow - compactionOptions.reserveTokens
  if (viewTokens <= tokenBudget) return

  // 从尾部留下大约 keepRecentTokens,再保证不劈开工具调用和结果
  const boundary = findTokenCut(context.messages, summarizedCount, compactionOptions.keepRecentTokens)
  // 切点没往前进就没有新东西可摘要,别空转
  if (boundary <= summarizedCount) return

  const newMessages = context.messages.slice(summarizedCount, boundary)
  const fileOperations = collectFileOperations(newMessages)
  const readFiles = mergePaths(compaction?.readFiles, fileOperations.readFiles)
  const modifiedFiles = mergePaths(compaction?.modifiedFiles, fileOperations.modifiedFiles)

  // 上一次的摘要要带上:这轮是把新消息合并进旧摘要,
  // 只总结新增的部分会把之前压缩掉的历史弄丢。
  const previousSummary = compaction?.summary
  const conversationText = newMessages.map(flattenMessage).join('\n')
  const prompt = previousSummary
    ? `<conversation>\n${conversationText}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${UPDATE_SUMMARY_PROMPT}`
    : `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARY_PROMPT}`

  // 用一轮额外的调用做总结,不走工具
  const summaryContext: Context = {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  }

  const summaryOptions: StreamOptions = { signal, transport: options.transport, logger: options.logger }
  const completion = await completeText(model, summaryContext, summaryOptions)
  if (signal?.aborted) return

  // 兜底:压缩失败就保持原样,不用空摘要替换
  if (completion.failed || !completion.text.trim()) {
    options.logger?.warn(
      {
        summarizedCount,
        boundary,
        viewTokens,
        model: model.model,
        reason: completion.failed ? '请求失败' : '摘要为空',
      },
      '上下文压缩失败,保留原始消息',
    )
    return
  }

  const summary = completion.text.trim()
  options.logger?.info(
    { summarizedCount, boundary, viewTokens, summaryLength: summary.length, model: model.model },
    '上下文已压缩',
  )

  context.compaction = { summarizedCount: boundary, summary, readFiles, modifiedFiles }
}
