// src/agent.ts
// Agent 主循环:流式拿回复 → 有 tool_call 就执行 → 结果塞回 context → 再问模型。
// 直到模型不再调工具,或者被 abort / 出错。
//
// 工具参数是不可信输入:执行前先校验,不合法的不执行,把错误回填给模型让它重发。

import {
  stream,
  buildAssistantMessage,
  buildToolResultMessage,
  type Model,
  type Context,
  type StreamOptions,
} from './llm.ts'
import { validateToolArguments } from './validation.ts'
import { withFileMutationQueue } from './mutationQueue.ts'
import {
  buildModelContext,
  compactContext,
  type CompactionOptions,
} from './compaction.ts'
import type { Transport } from './transport.ts'
import type { Logger } from './logger.ts'
import type { Message } from './messages.ts'

// 工具定义:name + 描述 + JSON Schema 参数 + execute 函数
export type AgentTool = {
  name: string
  description: string
  parameters: object   // JSON Schema
  execute: (args: unknown, signal?: AbortSignal) => Promise<string>
  /**
   * 这个工具会修改哪些文件,值是参数名。
   * 声明了就会按文件串行化,避免并发执行时互相覆盖。
   * 比如 ['path'] 表示 args.path 是被修改的文件。
   * 不声明视为不修改文件,可以自由并发。
   */
  mutatesFiles?: string[]
  /**
   * 强制单独执行,不和任何别的工具并发。
   * 用于本身就不适合并发的工具。
   */
  sequential?: boolean
  /**
   * 执行前要经过审批模型。
   * 写文件、改文件、跑命令会改工作区,不能由主力模型自己放行。
   * 没注入审批器时不拦——测试和旧调用保持直接执行。
   */
  requiresApproval?: boolean
}

/** 交给审批模型的一次工具调用 */
export interface ApprovalRequest {
  toolName: string
  args: unknown
  /** 最近一条用户原话,用来对照这个动作是不是用户要的 */
  userIntent: string
}

/** 审批结论。解析失败时调用方应当成拒绝 */
export interface ApprovalDecision {
  allowed: boolean
  reason: string
}

export type Approver = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>

// agent 对外的事件流,给 UI 消费
export type AgentEvent =
  | { type: 'assistant_text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'permission'; id: string; name: string; allowed: boolean; reason: string }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' }

// compaction 触发阈值:消息数超过这个值就压缩旧消息
const DEFAULT_COMPACT_THRESHOLD = 50
// compaction 保留最近这么多条消息
const DEFAULT_KEEP_RECENT = 20

// 压缩的默认配置。runAgent 的参数可以覆盖。
const defaultCompactionOptions: CompactionOptions = {
  threshold: DEFAULT_COMPACT_THRESHOLD,
  keepRecent: DEFAULT_KEEP_RECENT,
}

// 运行 agent 循环,没有步数上限——模型说停就停。
export async function* runAgent(
  model: Model,
  context: Context,
  tools: AgentTool[],
  signal?: AbortSignal,
  options: {
    transport?: Transport
    logger?: Logger
    toolExecution?: 'parallel' | 'sequential'
    compaction?: CompactionOptions
    /**
     * 压缩用的小模型。不传就用主力模型,避免旧调用突然多一条配置。
     * 正式入口会传小模型,对话循环本身仍只用 model。
     */
    compactionModel?: Model
    /** 有副作用的工具在执行前问它。不传则不审批 */
    approve?: Approver
  } = {},
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))
  const toolDefs = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))

  // 压缩状态存在 context.compaction 里,跨回合存活。
  // 它只影响发给模型的视图,context.messages 始终保持完整——
  // 会话存储和 /resume 恢复出来的都是完整历史。
  const compactionOptions = options.compaction ?? defaultCompactionOptions

  while (true) {
    // 0. 消息过多时先让小模型判断要不要压缩。对话循环不拿主力模型做这件事。
    await compactContext(
      options.compactionModel ?? model,
      context,
      signal,
      options,
      compactionOptions,
    )

    // 1. 流式调用 LLM,收集文本和 tool_calls
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    const toolCalls: { id: string; name: string; args: unknown; argsInvalid: boolean }[] = []

    const streamOptions: StreamOptions = {
      tools: toolDefs,
      signal,
      transport: options.transport,
      logger: options.logger,
    }
    // 压缩后的视图才是发给模型的内容
    const modelContext = buildModelContext(context, context.compaction)
    for await (const event of stream(model, modelContext, streamOptions)) {
      if (event.type === 'text_delta') {
        text += event.delta
        yield { type: 'assistant_text', delta: event.delta }
      } else if (event.type === 'tool_call') {
        toolCalls.push({ id: event.id, name: event.name, args: event.args, argsInvalid: event.argsInvalid })
        yield { type: 'tool_call', id: event.id, name: event.name, args: event.args }
      } else if (event.type === 'done') {
        stopReason = event.stopReason
        if (event.stopReason === 'aborted') {
          // abort 时丢弃 tool_calls——没有配对的 tool_result,
          // 下次恢复会话时 API 会直接 400
          context.messages.push(buildAssistantMessage(text, []))
          yield { type: 'turn_end', stopReason: 'aborted' }
          return
        }
      } else if (event.type === 'error') {
        context.messages.push(buildAssistantMessage(text, []))
        yield { type: 'assistant_text', delta: `\n[error] ${event.error.message}` }
        yield { type: 'turn_end', stopReason: 'error' }
        return
      }
    }

    // 2. 把 assistant 回复塞回 context
    context.messages.push(buildAssistantMessage(text, toolCalls))

    // 3. max_tokens 截断:tool args 可能不完整,不能执行,
    //    把错误放回 context 让模型重发一次
    if (stopReason === 'max_tokens' && toolCalls.length > 0) {
      const results = toolCalls.map((toolCall) => ({
        tool_use_id: toolCall.id,
        content: `error:output truncated by max_tokens,tool"${toolCall.name}" args may be incomplete.`,
      }))
      context.messages.push(buildToolResultMessage(results))
      for (let index = 0; index < toolCalls.length; index++) {
        yield {
          type: 'tool_result',
          id: toolCalls[index].id,
          name: toolCalls[index].name,
          result: results[index].content,
        }
      }
      continue
    }

    // 4. 没有 tool_call 就结束这一轮
    // API 可能返回 tool_use 但没有 tool_call delta,这种也算正常结束
    const reason = stopReason === 'tool_use' ? 'end_turn' : stopReason
    if (toolCalls.length === 0) {
      yield { type: 'turn_end', stopReason: reason }
      return
    }

    // 5. 执行 tool_calls
    //    预检(参数校验)在执行前做:不合法的不执行,把错误留给模型纠正
    //    argsInvalid 同理——空对象会让工具拿到 undefined 参数乱写
    const prepared = prepareToolCalls(toolCalls, toolMap)

    //    事件按原始顺序发,写进 context 的结果也按原始顺序:
    //    顺序错了下次恢复会话会 400,API 要求每个 tool_call 有配对的 tool_result
    const results: ToolResultEntry[] = []
    for await (const event of executeToolCalls(
      prepared,
      signal,
      options.toolExecution,
      {
        approve: options.approve,
        logger: options.logger,
        userIntent: latestUserIntent(context.messages),
      },
    )) {
      if (event.type === 'permission') {
        yield event
        continue
      }
      results.push({ tool_use_id: event.id, content: event.result })
      yield { type: 'tool_result', id: event.id, name: event.name, result: event.result }
    }

    // 6. 把 tool_result 放回 context
    context.messages.push(buildToolResultMessage(results))

    // 7. 工具执行期间可能被打断(用户在工具跑着的时候按了 Ctrl+C)。
    //    这时不要再问模型了——请求发出去也会被 abort 白跑一趟,
    //    而且重试逻辑不认 abort,会把 abort 后的失败当网络错误重试。
    if (signal?.aborted) {
      yield { type: 'turn_end', stopReason: 'aborted' }
      return
    }
  }
}

// 一个待执行的工具调用,预检已经做完
type PreparedToolCall = {
  id: string
  name: string
  // 校验后的参数,执行时用它而不是原始参数
  args: unknown
  // 预检失败时没有对应的工具,也不执行
  tool?: AgentTool
  // 预检失败时的错误文本,非空则不执行
  error?: string
}

// tool_result 的内容
type ToolResultEntry = { tool_use_id: string; content: string }

// 预检:校验参数。不合法的不执行,把错误留给模型纠正。
// 这一步是串行的——顺便把类型转换做掉,后面直接用转换后的值。
function prepareToolCalls(
  toolCalls: { id: string; name: string; args: unknown; argsInvalid: boolean }[],
  toolMap: Map<string, AgentTool>,
): PreparedToolCall[] {
  const prepared: PreparedToolCall[] = []
  for (const toolCall of toolCalls) {
    const tool = toolMap.get(toolCall.name)
    if (toolCall.argsInvalid) {
      prepared.push({
        id: toolCall.id,
        name: toolCall.name,
        args: {},
        error: `error:tool"${toolCall.name}" arguments are not valid JSON,please resend complete arguments.`,
      })
      continue
    }
    if (!tool) {
      prepared.push({
        id: toolCall.id,
        name: toolCall.name,
        args: {},
        error: `error:tool "${toolCall.name} not found`,
      })
      continue
    }
    // 校验并顺带做类型转换:模型传 "42" 当数字用会转成 42,转不了才算失败
    const validation = validateToolArguments(tool.parameters, toolCall.args, toolCall.name)
    if (!validation.ok) {
      prepared.push({ id: toolCall.id, name: toolCall.name, args: {}, tool, error: validation.error })
      continue
    }
    prepared.push({ id: toolCall.id, name: toolCall.name, args: validation.value, tool })
  }
  return prepared
}

// 执行单个工具,异常转成给模型看的文本
async function executeOneTool(prepared: PreparedToolCall, signal?: AbortSignal): Promise<string> {
  if (!prepared.tool) return prepared.error ?? 'error:tool not found'
  try {
    return await prepared.tool.execute(prepared.args, signal)
  } catch (error) {
    return `error: ${(error as Error).message}`
  }
}

// 取工具要修改的文件路径
function getMutatedFilePaths(prepared: PreparedToolCall): string[] {
  const declared = prepared.tool?.mutatesFiles
  if (!declared) return []
  const args = prepared.args as Record<string, unknown>
  const paths: string[] = []
  for (const parameterName of declared) {
    const value = args[parameterName]
    if (typeof value === 'string' && value) {
      paths.push(value)
    } else if (Array.isArray(value)) {
      // 参数也可以声明成路径数组
      for (const item of value) {
        if (typeof item === 'string' && item) paths.push(item)
      }
    }
  }
  return paths
}

// 同一工具可能要改多个文件:按路径排序后依次拿锁。
// 全局排序避免两个工具以相反顺序拿锁,互相等死。
async function withMutationQueues(paths: string[], operation: () => Promise<string>): Promise<string> {
  const sortedPaths = [...paths].sort()
  let run = operation
  for (const filePath of sortedPaths) {
    const inner = run
    run = () => withFileMutationQueue(filePath, inner)
  }
  return await run()
}

// 最近一条用户原话。tool_result 也是 role:user,但它是数组,不能当成意图。
function latestUserIntent(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    const text = message.content.trim()
    if (text) return text
  }
  return ''
}

type ToolRunOutcome = {
  result: string
  permission?: { allowed: boolean; reason: string }
}

// 需要审批的工具先问审批模型,通过了才执行。
// 审批在拿文件锁之前做:被拒绝的调用不该占着队列。
async function runOneTool(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  gate: { approve?: Approver; logger?: Logger; userIntent: string },
): Promise<ToolRunOutcome> {
  if (prepared.error) return { result: prepared.error }
  if (signal?.aborted) return { result: 'error:aborted' }

  let permission: ToolRunOutcome['permission']
  if (prepared.tool?.requiresApproval && gate.approve) {
    let decision: ApprovalDecision
    try {
      decision = await gate.approve(
        { toolName: prepared.name, args: prepared.args, userIntent: gate.userIntent },
        signal,
      )
    } catch (error) {
      // 审批器自己抛错也拒绝。放行会把故障变成一次没人看过的写操作。
      gate.logger?.warn(
        { toolName: prepared.name, errorMessage: (error as Error).message },
        '审批器抛错,拒绝执行',
      )
      decision = { allowed: false, reason: '审批过程出错,已拒绝执行' }
    }
    if (signal?.aborted) return { result: 'error:aborted' }
    permission = { allowed: decision.allowed, reason: decision.reason }
    if (!decision.allowed) {
      return { result: `error:permission denied: ${decision.reason}`, permission }
    }
  }

  const mutatedPaths = getMutatedFilePaths(prepared)
  if (mutatedPaths.length > 0) {
    const result = await withMutationQueues(mutatedPaths, async () => {
      // 排队期间可能已经被 abort 了,这时不必再执行
      if (signal?.aborted) return 'error:aborted'
      return await executeOneTool(prepared, signal)
    })
    return { result, permission }
  }
  return { result: await executeOneTool(prepared, signal), permission }
}

// 把工具批次切成若干段:连续的普通工具合成一段并发跑,
// 声明了 sequential 的工具单独成段,不和别的工具抢跑。
function splitIntoSegments(prepared: PreparedToolCall[]): number[][] {
  const segments: number[][] = []
  let current: number[] = []
  prepared.forEach((item, index) => {
    if (item.tool?.sequential) {
      if (current.length > 0) {
        segments.push(current)
        current = []
      }
      segments.push([index])
      return
    }
    current.push(index)
  })
  if (current.length > 0) segments.push(current)
  return segments
}

// 执行工具,按原始顺序发出 tool_result 事件。
//
// 两层保证:
// 1. 修改同一文件的工具按文件路径串行化(mutatesFiles),不会互相覆盖
// 2. 事件按原始顺序发,和模型发出的顺序一致,便于对照排查
type ToolExecutionEvent =
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'permission'; id: string; name: string; allowed: boolean; reason: string }

function yieldToolOutcome(
  prepared: PreparedToolCall,
  outcome: ToolRunOutcome,
): ToolExecutionEvent[] {
  const events: ToolExecutionEvent[] = []
  if (outcome.permission) {
    events.push({
      type: 'permission',
      id: prepared.id,
      name: prepared.name,
      allowed: outcome.permission.allowed,
      reason: outcome.permission.reason,
    })
  }
  events.push({
    type: 'tool_result',
    id: prepared.id,
    name: prepared.name,
    result: outcome.result,
  })
  return events
}

// 执行工具,按原始顺序发出 tool_result 事件。
//
// 两层保证:
// 1. 修改同一文件的工具按文件路径串行化(mutatesFiles),不会互相覆盖
// 2. 事件按原始顺序发,和模型发出的顺序一致,便于对照排查
async function* executeToolCalls(
  prepared: PreparedToolCall[],
  signal?: AbortSignal,
  mode: 'parallel' | 'sequential' = 'parallel',
  gate: { approve?: Approver; logger?: Logger; userIntent: string } = { userIntent: '' },
): AsyncGenerator<ToolExecutionEvent> {
  const outcomes: ToolRunOutcome[] = new Array(prepared.length)

  if (mode === 'sequential') {
    for (let index = 0; index < prepared.length; index++) {
      outcomes[index] = await runOneTool(prepared[index], signal, gate)
      yield* yieldToolOutcome(prepared[index], outcomes[index])
    }
    return
  }

  // 并行:段内并发,段与段之间等前一段跑完。
  // 审批可以同时问,但事件仍按模型发出的顺序吐出。
  for (const segment of splitIntoSegments(prepared)) {
    await Promise.all(segment.map(async (index) => {
      outcomes[index] = await runOneTool(prepared[index], signal, gate)
    }))
    for (const index of segment) {
      yield* yieldToolOutcome(prepared[index], outcomes[index])
    }
  }
}
