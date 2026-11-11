// src/agent/agent.ts
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
} from '../llm/llm.ts'
import { validateToolArguments } from '../core/validation.ts'
import { withFileMutationQueue } from '../core/mutationQueue.ts'
import {
  buildModelContext,
  compactContext,
  compactionPending,
  DEFAULT_COMPACT_KEEP_RECENT_TOKENS,
  DEFAULT_COMPACT_RESERVE_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  type CompactionOptions,
} from '../llm/compaction.ts'
import type { Transport } from '../core/transport.ts'
import type { Logger } from '../core/logger.ts'
import {
  appendHookContext,
  type HookEffect,
  type HookRunner,
  type ResolvedHookPath,
} from './hooks.ts'
import { createPathGuard, type PathGuard } from '../core/pathGuard.ts'

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
}

// agent 对外的事件流,给 UI 消费
export type AgentEvent =
  | { type: 'assistant_text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'hook_notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' }

// Stop 钩子可以要求模型继续。没有上限的话,一个总是拒绝的脚本会把回合卡死。
const DEFAULT_MAX_STOP_CONTINUATIONS = 5

// 压缩的默认配置。runAgent 的参数可以覆盖。
// 数字和配置层的默认值是同一组,定义在 compaction.ts。
const defaultCompactionOptions: CompactionOptions = {
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  reserveTokens: DEFAULT_COMPACT_RESERVE_TOKENS,
  keepRecentTokens: DEFAULT_COMPACT_KEEP_RECENT_TOKENS,
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
    hooks?: HookRunner
    /** Stop 钩子最多把回合拉回来几次。测试可以把它调小。 */
    maxStopContinuations?: number
    /**
     * 工作区根。给了就把路径参数解析成真实路径一并交给 PreToolUse 钩子,
     * 钩子不用自己写 realpath。远程世界的路径不在本机,别给。
     */
    workspaceRoot?: string
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
  const hooks = options.hooks
  let stopContinuations = 0
  const maxStopContinuations = options.maxStopContinuations ?? DEFAULT_MAX_STOP_CONTINUATIONS
  // 本回合写过的文件。Stop 钩子用它判断「有没有改动」,不用再自己去查 git。
  const changedFiles = new Set<string>()
  // 路径解析器。建一次就够,realpath 有开销。建不出来(路径不存在等)时钩子拿不到解析结果。
  const pathGuard = options.workspaceRoot
    ? await createPathGuard(options.workspaceRoot).catch(() => undefined)
    : undefined

  while (true) {
    // 0. 消息过多时先压缩旧消息。钩子可以否决这一次压缩,历史保持原样。
    if (hooks && signal?.aborted) {
      yield { type: 'turn_end', stopReason: 'aborted' }
      return
    }
    if (hooks && compactionPending(context, compactionOptions)) {
      const preCompact = await hooks.run({
        event: 'PreCompact',
        messageCount: context.messages.length,
      }, signal)
      for (const notice of noticesFrom(preCompact)) yield notice
      if (preCompact.aborted) {
        yield { type: 'turn_end', stopReason: 'aborted' }
        return
      }
      if (preCompact.blocked || preCompact.preventContinuation) {
        options.logger?.info(
          { reason: preCompact.reason, messageCount: context.messages.length },
          '钩子跳过了上下文压缩',
        )
      } else {
        await compactContext(model, context, signal, options, compactionOptions)
      }
    } else {
      await compactContext(model, context, signal, options, compactionOptions)
    }

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
      const continued = yield* applyStopHook(context, text, hooks, signal, {
        stopContinuations,
        maxStopContinuations,
        changedFiles: [...changedFiles],
        logger: options.logger,
      })
      if (continued === 'aborted') {
        yield { type: 'turn_end', stopReason: 'aborted' }
        return
      }
      if (continued === 'continue') {
        stopContinuations += 1
        continue
      }
      yield { type: 'turn_end', stopReason: reason }
      return
    }

    // 5. 执行 tool_calls
    //    预检(参数校验)在执行前做:不合法的不执行,把错误留给模型纠正
    //    argsInvalid 同理——空对象会让工具拿到 undefined 参数乱写
    //    钩子在校验之后、执行之前跑。它能拒绝,或给出一份新参数——新参数还要再校验一遍。
    const prepared = prepareToolCalls(toolCalls, toolMap)
    const pre = await applyPreToolHooks(prepared, hooks, signal, options.logger, pathGuard)
    for (const notice of pre.notices) yield notice
    if (pre.aborted) {
      // 钩子还没跑完就被打断。工具一个都没执行,但每个 tool_call 仍要有 tool_result。
      const abortedResults = toolCalls.map((toolCall) => ({
        tool_use_id: toolCall.id,
        content: 'error:aborted',
      }))
      context.messages.push(buildToolResultMessage(abortedResults))
      for (const toolCall of toolCalls) {
        yield { type: 'tool_result', id: toolCall.id, name: toolCall.name, result: 'error:aborted' }
      }
      yield { type: 'turn_end', stopReason: 'aborted' }
      return
    }

    // 钩子改写并实际执行的参数,写进历史的也得是这份。
    // 否则下一轮模型看到的是自己原来的参数,结果却是改写后的。
    const lastAssistant = context.messages[context.messages.length - 1]
    if (lastAssistant) {
      context.messages[context.messages.length - 1] = buildAssistantMessage(
        text,
        toolCalls.map((toolCall, index) => {
          const item = prepared[index]
          if (item?.inputReplaced && !item.error) {
            return { id: toolCall.id, name: toolCall.name, args: item.args }
          }
          return { id: toolCall.id, name: toolCall.name, args: toolCall.args }
        }),
      )
    }

    //    事件按原始顺序发,写进 context 的结果也按原始顺序:
    //    顺序错了下次恢复会话会 400,API 要求每个 tool_call 有配对的 tool_result
    const results: ToolResultEntry[] = []
    const hookControl = { preventContinuation: pre.preventContinuation }
    for await (const event of executeToolCalls(prepared, signal, options.toolExecution, hooks, hookControl, changedFiles)) {
      if (event.type === 'tool_result') {
        results.push({ tool_use_id: event.id, content: event.result })
      }
      yield event
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
    // 钩子说「做到这里就停」。结果已经配对写回,不再问模型。
    if (hookControl.preventContinuation) {
      yield { type: 'turn_end', stopReason: 'end_turn' }
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
  // 模型原始参数。校验失败时 args 会被换成空对象,钩子仍要看到模型到底传了什么。
  modelArgs: unknown
  // 参数 JSON 没解析出来。这种调用不交给钩子改写。
  argsInvalid: boolean
  // 预检失败时没有对应的工具,也不执行
  tool?: AgentTool
  // 预检失败时的错误文本,非空则不执行
  error?: string
  // 钩子给出的参数通过了校验,历史里要记这份
  inputReplaced?: boolean
  // 预检阶段被钩子拒绝。工具没跑,不再发 PostToolUseFailure。
  blockedByHook?: boolean
  // PreToolUse 附带的上下文,执行完后接到结果上
  hookContext?: string
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
        modelArgs: toolCall.args,
        argsInvalid: true,
        error: `error:tool"${toolCall.name}" arguments are not valid JSON,please resend complete arguments.`,
      })
      continue
    }
    if (!tool) {
      prepared.push({
        id: toolCall.id,
        name: toolCall.name,
        args: {},
        modelArgs: toolCall.args,
        argsInvalid: false,
        error: `error:tool "${toolCall.name} not found`,
      })
      continue
    }
    // 校验并顺带做类型转换:模型传 "42" 当数字用会转成 42,转不了才算失败
    const validation = validateToolArguments(tool.parameters, toolCall.args, toolCall.name)
    if (!validation.ok) {
      prepared.push({
        id: toolCall.id,
        name: toolCall.name,
        args: {},
        modelArgs: toolCall.args,
        argsInvalid: false,
        tool,
        error: validation.error,
      })
      continue
    }
    prepared.push({
      id: toolCall.id,
      name: toolCall.name,
      args: validation.value,
      modelArgs: toolCall.args,
      argsInvalid: false,
      tool,
    })
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

// 执行一个工具调用,返回结果文本
async function runOneTool(prepared: PreparedToolCall, signal?: AbortSignal): Promise<string> {
  if (prepared.error) return prepared.error
  if (signal?.aborted) return 'error:aborted'

  const mutatedPaths = getMutatedFilePaths(prepared)
  if (mutatedPaths.length > 0) {
    return await withMutationQueues(mutatedPaths, async () => {
      // 排队期间可能已经被 abort 了,这时不必再执行
      if (signal?.aborted) return 'error:aborted'
      return await executeOneTool(prepared, signal)
    })
  }
  return await executeOneTool(prepared, signal)
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
async function* executeToolCalls(
  prepared: PreparedToolCall[],
  signal?: AbortSignal,
  mode: 'parallel' | 'sequential' = 'parallel',
  hooks?: HookRunner,
  hookControl: { preventContinuation: boolean } = { preventContinuation: false },
  changedFiles?: Set<string>,
): AsyncGenerator<AgentEvent> {
  const results: string[] = new Array(prepared.length)

  const emitResult = async function* (index: number): AsyncGenerator<AgentEvent> {
    const finalized = await applyPostToolHook(prepared[index], results[index], hooks, signal)
    if (finalized.preventContinuation) hookControl.preventContinuation = true
    for (const notice of finalized.notices) yield notice
    yield {
      type: 'tool_result',
      id: prepared[index].id,
      name: prepared[index].name,
      result: finalized.result,
    }
  }

  if (mode === 'sequential') {
    for (let index = 0; index < prepared.length; index++) {
      results[index] = await runOneTool(prepared[index], signal)
      collectChangedFiles(prepared[index], results[index], changedFiles)
      yield* emitResult(index)
    }
    return
  }

  // 并行:段内并发,段与段之间等前一段跑完。
  // 钩子在段跑完之后按原顺序串行跑,避免改写结果时互相踩。
  for (const segment of splitIntoSegments(prepared)) {
    await Promise.all(segment.map(async (index) => {
      results[index] = await runOneTool(prepared[index], signal)
    }))
    for (const index of segment) {
      collectChangedFiles(prepared[index], results[index], changedFiles)
      yield* emitResult(index)
    }
  }
}

/**
 * 记下这个工具实际改过的文件。
 *
 * 只认声明了 mutatesFiles 的工具,并且只认执行成功的——
 * 报错的写入没落到磁盘上,记进去会让「有没有改动」的判断失真。
 *
 * 路径是模型给的那个(通常是相对路径)。绝对路径由钩子那边的
 * resolved_paths 提供,两边靠原始写法对上号。
 */
function collectChangedFiles(
  prepared: PreparedToolCall,
  result: string,
  changedFiles: Set<string> | undefined,
): void {
  if (!changedFiles) return
  if (result.startsWith('error:')) return
  const mutatedPaths = getMutatedFilePaths(prepared)
  for (const mutatedPath of mutatedPaths) changedFiles.add(mutatedPath)
}

function noticesFrom(effect: HookEffect): AgentEvent[] {
  const notices: AgentEvent[] = []
  for (const message of effect.systemMessages) {
    notices.push({ type: 'hook_notice', level: 'info', message })
  }
  for (const error of effect.errors) {
    notices.push({ type: 'hook_notice', level: 'error', message: error })
  }
  return notices
}

// Stop 钩子拒绝时,把理由塞回上下文再问一次模型。
// 返回 continue 表示调用方要再跑一轮;stop 表示可以结束;aborted 表示被打断。
async function* applyStopHook(
  context: Context,
  assistantText: string,
  hooks: HookRunner | undefined,
  signal: AbortSignal | undefined,
  options: {
    stopContinuations: number
    maxStopContinuations: number
    changedFiles: string[]
    logger?: Logger
  },
): AsyncGenerator<AgentEvent, 'continue' | 'stop' | 'aborted'> {
  if (!hooks || signal?.aborted) return 'stop'
  if (options.stopContinuations >= options.maxStopContinuations) {
    // 只有前面真的被拉回来过才提示。上限配成 0 时直接结束,不当成钩子失败。
    if (options.stopContinuations > 0) {
      options.logger?.warn(
        { maxStopContinuations: options.maxStopContinuations },
        'Stop 钩子要求继续的次数已达上限,本回合结束',
      )
      yield {
        type: 'hook_notice',
        level: 'warn',
        message: 'Stop 钩子要求继续的次数已达上限,本回合结束',
      }
    }
    return 'stop'
  }

  const effect = await hooks.run({
    event: 'Stop',
    prompt: assistantText,
    // 已经拉回过就把这个标记给钩子:它该决定是再要求一次,还是放行。
    // 不给这个标记的话,钩子脚本只能靠猜,容易写出死循环。
    stopHookActive: options.stopContinuations > 0,
    changedFiles: options.changedFiles,
  }, signal)
  for (const notice of noticesFrom(effect)) yield notice
  if (effect.aborted) return 'aborted'
  if (!effect.blocked) {
    // 没拒绝就意味着这一轮到此为止。钩子给的额外上下文没人会读了,
    // 丢掉它得留个记录,不然用户以为钩子生效了。
    if (effect.additionalContext) {
      options.logger?.info(
        { contextLength: effect.additionalContext.length },
        'Stop 钩子返回了额外上下文,但没有拒绝本回合,内容未使用',
      )
    }
    return 'stop'
  }

  const reason = effect.reason ?? 'Stop 钩子要求继续'
  yield { type: 'hook_notice', level: 'warn', message: reason }
  context.messages.push({
    role: 'user',
    content: appendHookContext(`Stop 钩子要求继续。\n${reason}`, effect.additionalContext),
  })
  return 'continue'
}

async function applyPreToolHooks(
  prepared: PreparedToolCall[],
  hooks: HookRunner | undefined,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
  pathGuard: PathGuard | undefined,
): Promise<{ aborted: boolean; preventContinuation: boolean; notices: AgentEvent[] }> {
  const notices: AgentEvent[] = []
  if (!hooks) return { aborted: false, preventContinuation: false, notices }

  let preventContinuation = false
  for (const item of prepared) {
    if (signal?.aborted) return { aborted: true, preventContinuation, notices }
    // 没有工具,或参数 JSON 是坏的:钩子改写不了,沿用原来的错误。
    if (!item.tool || item.argsInvalid) continue

    const effect = await hooks.run({
      event: 'PreToolUse',
      toolName: item.name,
      toolInput: item.error ? item.modelArgs : item.args,
      toolUseId: item.id,
      resolvedPaths: await resolveHookPaths(item, pathGuard, logger),
    }, signal)
    notices.push(...noticesFrom(effect))
    if (effect.aborted) return { aborted: true, preventContinuation, notices }
    if (effect.preventContinuation) preventContinuation = true
    if (effect.additionalContext) item.hookContext = effect.additionalContext

    if (effect.blocked) {
      item.error = `error: blocked by hook: ${effect.reason ?? 'Blocked by hook'}`
      item.blockedByHook = true
      continue
    }
    if (!effect.updatedInput) continue

    const validation = validateToolArguments(item.tool.parameters, effect.updatedInput, item.name)
    if (!validation.ok) {
      item.args = effect.updatedInput
      item.error = validation.error
      item.inputReplaced = false
      logger?.warn({ tool: item.name, toolUseId: item.id }, '钩子改写的参数未通过校验,工具不执行')
      continue
    }
    item.args = validation.value
    item.error = undefined
    item.inputReplaced = true
  }

  return { aborted: false, preventContinuation, notices }
}

/**
 * 把工具参数里的路径解析成真实路径,交给 PreToolUse 钩子。
 *
 * 钩子要拦「不许写某个目录」时,自己写 resolve + realpath 很容易漏掉软链那一层。
 * 这里算好给它,钩子只要看 insideWorkspace 和 real。
 *
 * 只有声明了 mutatesFiles 的工具才有路径参数。没给工作区根(远程世界)时
 * 返回空数组——本机解析不了远程的路径,硬算会给出错误结论。
 */
async function resolveHookPaths(
  prepared: PreparedToolCall,
  pathGuard: PathGuard | undefined,
  logger: Logger | undefined,
): Promise<ResolvedHookPath[] | undefined> {
  if (!pathGuard) return undefined
  const declared = prepared.tool?.mutatesFiles
  if (!declared || declared.length === 0) return undefined

  const args = prepared.args as Record<string, unknown>
  const requestedPaths: string[] = []
  for (const parameterName of declared) {
    const value = args[parameterName]
    if (typeof value === 'string' && value) requestedPaths.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item) requestedPaths.push(item)
      }
    }
  }
  if (requestedPaths.length === 0) return undefined

  const resolved: ResolvedHookPath[] = []
  for (const requested of requestedPaths) {
    try {
      const real = await pathGuard.resolve(requested)
      resolved.push({ requested, real, insideWorkspace: true })
    } catch (error) {
      // 解析失败就是越界(或者路径本身有问题)。真实路径给不出,
      // 但 insideWorkspace=false 已经够钩子做判断了。
      const message = (error as Error).message
      logger?.debug({ requested, errorMessage: message }, '路径解析失败,按越界处理')
      resolved.push({ requested, real: requested, insideWorkspace: false })
    }
  }
  return resolved
}

async function applyPostToolHook(
  item: PreparedToolCall,
  result: string,
  hooks: HookRunner | undefined,
  signal: AbortSignal | undefined,
): Promise<{ result: string; notices: AgentEvent[]; preventContinuation: boolean }> {
  const withPreContext = appendHookContext(result, item.hookContext)
  if (!hooks || signal?.aborted || item.blockedByHook || result === 'error:aborted') {
    return { result: withPreContext, notices: [], preventContinuation: false }
  }

  const failed = Boolean(item.error) || result.startsWith('error:')
  const effect = await hooks.run({
    event: failed ? 'PostToolUseFailure' : 'PostToolUse',
    toolName: item.name,
    toolInput: item.error && !item.inputReplaced ? item.modelArgs : item.args,
    toolOutput: result,
    toolUseId: item.id,
    error: failed ? (item.error ?? result) : undefined,
  }, signal)
  if (effect.aborted) {
    return { result: withPreContext, notices: noticesFrom(effect), preventContinuation: false }
  }

  let output = effect.updatedOutput !== undefined ? effect.updatedOutput : result
  if (effect.blocked && effect.reason) {
    output = appendHookContext(output, effect.reason)
  }
  output = appendHookContext(output, item.hookContext)
  output = appendHookContext(output, effect.additionalContext)
  return {
    result: output,
    notices: noticesFrom(effect),
    preventContinuation: effect.preventContinuation,
  }
}
