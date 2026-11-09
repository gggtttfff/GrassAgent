// src/hooks.ts
// 钩子 —— 回合生命周期上的扩展点。
//
// 钩子不持有 agent 状态,也不知道工具怎么执行。它只在固定的时刻看一眼
// 「即将发生的动作」,然后回答三件事:
//   - 允许还是拒绝
//   - 要不要改写参数或结果
//   - 要不要把额外上下文塞给模型
//
// 两种实现走同一份协议:
//   - 命令钩子:用户在 hooks.json 里写的 shell 命令。JSON 从 stdin 进去,
//     退出码和 stdout 决定结果。退出码 2 表示拒绝,这是 Claude Code 的约定,
//     已有的钩子脚本可以原样搬过来。
//   - 函数钩子:进程内的回调,测试和嵌入式调用用。
//
// 钩子是用户自己的代码,和 run_bash 同一信任边界。失败默认放行——
// 脚本崩了不该把整个会话卡死。只有它明确拒绝(退出码 2 或 decision=block)才拦截。

import { spawn, type ChildProcess } from 'node:child_process'
import { JsonSafetyError, parseJson, stringifyJson } from './jsonSafety.ts'
import type { Logger } from './logger.ts'

/** 当前回合里真实存在的时机。没有子代理、权限弹窗这些还没做的事件。 */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'PreCompact',
] as const

export type HookEventName = (typeof HOOK_EVENTS)[number]

/** 交给钩子的输入。字段用蛇形,和命令脚本看到的 JSON 一致。 */
export interface HookInput {
  hook_event_name: HookEventName
  session_id: string
  cwd: string
  tool_name?: string
  tool_input?: unknown
  tool_output?: string
  tool_use_id?: string
  prompt?: string
  error?: string
  message_count?: number
}

/** agent 和 cli 发起一次钩子调用时带的字段。蛇形转换在 runner 里做。 */
export interface HookRequest {
  event: HookEventName
  toolName?: string
  toolInput?: unknown
  toolOutput?: string
  toolUseId?: string
  prompt?: string
  error?: string
  messageCount?: number
}

/**
 * 钩子的成功输出。
 *
 * 命令钩子把这份结构写成 stdout 的 JSON;函数钩子直接返回它。
 * 纯文本 stdout 会被当成 additionalContext,不算失败。
 */
export interface HookOutput {
  /** false 表示这个动作做完就结束回合,不要再问模型 */
  continue?: boolean
  decision?: 'approve' | 'block'
  permissionDecision?: 'allow' | 'deny'
  reason?: string
  permissionDecisionReason?: string
  systemMessage?: string
  additionalContext?: string
  updatedInput?: Record<string, unknown>
  updatedOutput?: string
}

export type HookHandler = (
  input: HookInput,
  signal?: AbortSignal,
) => HookOutput | void | Promise<HookOutput | void>

export interface HookDefinition {
  event: HookEventName
  /** 正则。不写则这个事件上每次都跑。写了就匹配事件对应的文本(工具名、提示词等)。 */
  matcher?: RegExp
  command?: string
  handler?: HookHandler
  timeoutMs?: number
  /** 成功跑完一次后卸掉。失败或被打断不算跑完,下次还会再试。 */
  once?: boolean
  /** 日志里用的名字。不写就用命令本身。 */
  name?: string
}

/** 一次事件上所有钩子合并后的结果。拒绝是粘性的:后面的钩子不能把前面的拒绝翻回来。 */
export interface HookEffect {
  blocked: boolean
  preventContinuation: boolean
  /** 用户打断了钩子。调用方要走 abort 收尾,不能再执行工具。 */
  aborted: boolean
  reason?: string
  systemMessages: string[]
  additionalContext?: string
  updatedInput?: Record<string, unknown>
  updatedOutput?: string
  errors: string[]
}

export interface HookRunner {
  run(request: HookRequest, signal?: AbortSignal): Promise<HookEffect>
}

export interface HookRunnerOptions {
  sessionId: string
  cwd: string
  defaultTimeoutMs: number
  logger?: Logger
}

/** 塞进模型上下文时的标记,让模型分得清这不是用户原话。 */
export const HOOK_CONTEXT_MARK = '[hook]'

// 钩子输出进上下文,不是工具结果本身。太大就会把这一轮请求撑爆。
const MAX_HOOK_NOTE_CHARS = 8 * 1024
const MAX_HOOK_CONTEXT_CHARS = 64 * 1024
// 命令 stdout/stderr 的读取上限。超出就杀掉进程,避免一个失控脚本吃满内存。
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024

export function emptyHookEffect(): HookEffect {
  return {
    blocked: false,
    preventContinuation: false,
    aborted: false,
    systemMessages: [],
    errors: [],
  }
}

/** 把钩子给的额外上下文接到原文后面。空文本不接。 */
export function appendHookContext(text: string, hookContext: string | undefined): string {
  if (!hookContext) return text
  const marked = `${HOOK_CONTEXT_MARK}\n${hookContext}`
  if (!text) return marked
  return `${text}\n\n${marked}`
}

export function createHookRunner(definitions: HookDefinition[], options: HookRunnerOptions): HookRunner {
  const hooks = definitions.map((definition, index) => {
    const hasCommand = Boolean(definition.command)
    const hasHandler = Boolean(definition.handler)
    if (hasCommand === hasHandler) {
      throw new Error(`钩子 ${definition.event}#${index} 必须且只能有 command 或 handler 其中一个`)
    }
    return {
      ...definition,
      name: definition.name ?? definition.command ?? `function:${definition.event}:${index}`,
      consumed: false,
    }
  })

  return {
    async run(request, signal) {
      const effect = emptyHookEffect()
      // 前一个钩子改写的参数要传给后一个,否则它们看到的是同一份旧参数,改写无法叠加。
      let toolInput = request.toolInput

      for (const hook of hooks) {
        if (hook.consumed) continue
        if (hook.event !== request.event) continue
        if (!matcherMatches(hook.matcher, matchTarget({ ...request, toolInput }))) continue
        if (signal?.aborted) {
          effect.aborted = true
          break
        }

        const input = toHookInput({ ...request, toolInput }, options)
        const outcome = await runSingleHook(hook, input, request.event, signal, options)
        // 失败和打断都不算「跑完」。once 钩子下次还能再试,方便用户修好脚本。
        if (hook.once && !outcome.aborted && !outcome.error) hook.consumed = true

        applyOutcome(effect, outcome, options.logger, request.event, hook.name)
        // 已经拒绝了就不要再改参数。后面的钩子即使给了新参数,工具也不会跑,
        // 把 updatedInput 留在结果里会让调用方误以为这份参数会生效。
        if (outcome.output?.updatedInput && !outputBlocks(outcome.output) && !effect.blocked) {
          toolInput = outcome.output.updatedInput
          effect.updatedInput = outcome.output.updatedInput
        }
        if (outcome.aborted) break
      }

      if (effect.blocked) effect.updatedInput = undefined
      return effect
    },
  }
}

interface RunnableHook extends HookDefinition {
  name: string
  consumed: boolean
}

interface HookOutcome {
  output?: HookOutput
  error?: string
  aborted?: boolean
}

function matchTarget(request: HookRequest): string {
  switch (request.event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return request.toolName ?? ''
    case 'UserPromptSubmit':
    case 'Stop':
      return request.prompt ?? ''
    case 'PreCompact':
      return String(request.messageCount ?? '')
    default:
      return request.event
  }
}

function matcherMatches(matcher: RegExp | undefined, target: string): boolean {
  if (!matcher) return true
  // 带 g/y 的正则会记住 lastIndex,下一次 test 可能从中间开始,把本该命中的漏掉。
  matcher.lastIndex = 0
  return matcher.test(target)
}

function toHookInput(request: HookRequest, options: HookRunnerOptions): HookInput {
  const input: HookInput = {
    hook_event_name: request.event,
    session_id: options.sessionId,
    cwd: options.cwd,
  }
  if (request.toolName !== undefined) input.tool_name = request.toolName
  if (request.toolInput !== undefined) input.tool_input = request.toolInput
  if (request.toolOutput !== undefined) input.tool_output = request.toolOutput
  if (request.toolUseId !== undefined) input.tool_use_id = request.toolUseId
  if (request.prompt !== undefined) input.prompt = request.prompt
  if (request.error !== undefined) input.error = request.error
  if (request.messageCount !== undefined) input.message_count = request.messageCount
  return input
}

function outputBlocks(output: HookOutput): boolean {
  return output.decision === 'block' || output.permissionDecision === 'deny'
}

function applyOutcome(
  effect: HookEffect,
  outcome: HookOutcome,
  logger: Logger | undefined,
  event: HookEventName,
  hookName: string,
): void {
  if (outcome.aborted) {
    effect.aborted = true
    return
  }
  if (outcome.error) {
    effect.errors.push(outcome.error)
    // 失败放行。记下来,不然用户只看到模型继续跑,不知道钩子根本没生效。
    logger?.warn({ event, hook: hookName, errorMessage: outcome.error }, '钩子执行失败,已跳过')
    return
  }
  const output = outcome.output
  if (!output) return

  if (output.systemMessage) {
    effect.systemMessages.push(truncate(output.systemMessage, MAX_HOOK_NOTE_CHARS))
  }
  if (output.additionalContext) {
    const text = truncate(output.additionalContext, MAX_HOOK_CONTEXT_CHARS)
    effect.additionalContext = effect.additionalContext
      ? `${effect.additionalContext}\n${text}`
      : text
  }
  if (output.updatedOutput !== undefined) {
    effect.updatedOutput = truncate(output.updatedOutput, MAX_HOOK_CONTEXT_CHARS)
  }
  if (outputBlocks(output)) {
    effect.blocked = true
    if (!effect.reason) {
      effect.reason = truncate(output.permissionDecisionReason ?? output.reason ?? 'Blocked by hook', MAX_HOOK_NOTE_CHARS)
    }
    logger?.info({ event, hook: hookName, reason: effect.reason }, '钩子拒绝了这次动作')
  }
  if (output.continue === false) {
    effect.preventContinuation = true
    if (!effect.reason && output.reason) {
      effect.reason = truncate(output.reason, MAX_HOOK_NOTE_CHARS)
    }
    logger?.info({ event, hook: hookName, reason: effect.reason }, '钩子要求结束当前回合')
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…(hook output truncated)`
}

async function runSingleHook(
  hook: RunnableHook,
  input: HookInput,
  event: HookEventName,
  signal: AbortSignal | undefined,
  options: HookRunnerOptions,
): Promise<HookOutcome> {
  if (hook.handler) return runFunctionHook(hook, input, signal, options)
  return runCommandHook(hook, input, event, signal, options)
}

async function runFunctionHook(
  hook: RunnableHook,
  input: HookInput,
  signal: AbortSignal | undefined,
  options: HookRunnerOptions,
): Promise<HookOutcome> {
  const timeoutMs = hook.timeoutMs ?? options.defaultTimeoutMs
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onParentAbort, { once: true })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  // 给 handler 自己的 rejection 接住。超时赢了竞态之后,回调还可能再抛一次,
  // 不接住就会变成未处理的 rejection。
  const work = Promise.resolve()
    .then(() => hook.handler!(input, controller.signal))
    .then((output) => ({ output, error: undefined as unknown }))
    .catch((error: unknown) => ({ output: undefined, error }))

  try {
    const outcome = await Promise.race([work, waitForAbort(controller.signal)])
    if (signal?.aborted) return { aborted: true }
    if (timedOut) return { error: `钩子超时 (${timeoutMs}ms)` }
    if (outcome.error) {
      const error = outcome.error
      return { error: error instanceof Error ? error.message : String(error) }
    }
    if (!outcome.output) return {}
    return { output: outcome.output }
  } catch {
    if (signal?.aborted) return { aborted: true }
    if (timedOut) return { error: `钩子超时 (${timeoutMs}ms)` }
    return { error: '钩子已中断' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }, { once: true })
  })
}

async function runCommandHook(
  hook: RunnableHook,
  input: HookInput,
  event: HookEventName,
  signal: AbortSignal | undefined,
  options: HookRunnerOptions,
): Promise<HookOutcome> {
  const timeoutMs = hook.timeoutMs ?? options.defaultTimeoutMs
  const command = hook.command
  if (!command) return { error: '钩子没有命令' }
  let payload: string
  try {
    payload = stringifyJson(input)
  } catch (error) {
    if (error instanceof JsonSafetyError) return { error: error.message }
    throw error
  }

  let child: ChildProcess
  try {
    child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      env: {
        ...process.env,
        GRASSAGENT_HOOK_EVENT: event,
        GRASSAGENT_SESSION_ID: options.sessionId,
        GRASSAGENT_WORKSPACE: options.cwd,
      },
      // Unix 上让命令成为新进程组的组长,超时或打断时才能把 shell 和它拉起的子进程一起杀掉。
      // 只杀 shell 的话,真正干活的进程会留在后台。
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    return { error: `钩子启动失败: ${(error as Error).message}` }
  }

  const stdout = collectOutput(child.stdout, () => killChild(child))
  const stderr = collectOutput(child.stderr, () => killChild(child))

  // 先挂上退出监听再写 stdin。命令如果瞬间结束,close 会在监听之前发出,后面就会一直等。
  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })

  // 命令提前退出时 stdin 会 EPIPE。这不是钩子失败,吞掉即可。
  child.stdin?.on('error', () => {})
  child.stdin?.write(payload + '\n')
  child.stdin?.end()

  let timedOut = false
  let aborted = false
  const timer = setTimeout(() => {
    timedOut = true
    killChild(child)
  }, timeoutMs)
  const onAbort = (): void => {
    aborted = true
    killChild(child)
  }
  // 先监听再看当前状态。反过来的话,打断可能刚好落在两次检查之间,进程就停不下来。
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  try {
    const exitCode = await exitPromise

    if (aborted || signal?.aborted) return { aborted: true }
    if (timedOut) return { error: `钩子超时 (${timeoutMs}ms)` }
    if (stdout.truncated || stderr.truncated) {
      return { error: `钩子输出超过 ${MAX_COMMAND_OUTPUT_CHARS} 字符,已中止` }
    }

    // 退出码 2 是明确的拒绝。其余非 0 只当失败,放行。
    // 不把退出码 1 当成拒绝:脚本写错和「请不要执行」必须能分开。
    if (exitCode === 2) {
      const reason = firstText(stderr.text, stdout.text) || 'Blocked by hook'
      return { output: { decision: 'block', reason } }
    }
    if (exitCode !== 0) {
      const detail = firstText(stderr.text, stdout.text)
      return { error: detail ? `钩子退出码 ${exitCode}: ${detail}` : `钩子退出码 ${exitCode}` }
    }

    return parseCommandStdout(stdout.text, event)
  } catch (error) {
    if (aborted || signal?.aborted) return { aborted: true }
    return { error: `钩子启动失败: ${(error as Error).message}` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function parseCommandStdout(stdout: string, event: HookEventName): HookOutcome {
  const trimmed = stdout.trim()
  if (!trimmed) return {}
  // 不以 { 开头就当成人看的说明,塞进上下文。不要因为多打了一行日志就判失败。
  if (!trimmed.startsWith('{')) return { output: { additionalContext: trimmed } }

  let parsed: unknown
  try {
    parsed = parseJson(trimmed)
  } catch (error) {
    if (error instanceof JsonSafetyError) return { error: error.message }
    return { error: `钩子输出不是合法 JSON: ${(error as Error).message}` }
  }
  const output = parseHookOutput(parsed, event)
  if ('error' in output) return output
  return { output }
}

/** 校验命令 stdout 的 JSON。字段不对就整份丢弃,避免半份改写配上半份拒绝。 */
export function parseHookOutput(value: unknown, event: HookEventName): HookOutput | { error: string } {
  if (!isPlainObject(value)) return { error: '钩子输出必须是 JSON 对象' }

  const output: HookOutput = {}
  if ('continue' in value && value.continue !== undefined) {
    if (typeof value.continue !== 'boolean') return { error: 'continue 必须是布尔值' }
    output.continue = value.continue
  }
  if ('decision' in value && value.decision !== undefined) {
    if (value.decision !== 'approve' && value.decision !== 'block') {
      return { error: `未知的 decision: ${String(value.decision)}` }
    }
    output.decision = value.decision
  }
  if ('reason' in value && value.reason !== undefined) {
    if (typeof value.reason !== 'string') return { error: 'reason 必须是字符串' }
    output.reason = value.reason
  }
  if ('stopReason' in value && value.stopReason !== undefined) {
    if (typeof value.stopReason !== 'string') return { error: 'stopReason 必须是字符串' }
    if (!output.reason) output.reason = value.stopReason
  }
  if ('systemMessage' in value && value.systemMessage !== undefined) {
    if (typeof value.systemMessage !== 'string') return { error: 'systemMessage 必须是字符串' }
    output.systemMessage = value.systemMessage
  }

  if ('hookSpecificOutput' in value && value.hookSpecificOutput !== undefined) {
    if (!isPlainObject(value.hookSpecificOutput)) return { error: 'hookSpecificOutput 必须是对象' }
    const specific = value.hookSpecificOutput
    if (specific.hookEventName !== undefined && specific.hookEventName !== event) {
      return { error: `钩子返回的事件名不匹配: 期望 ${event}, 实际 ${String(specific.hookEventName)}` }
    }
    if (specific.permissionDecision !== undefined) {
      if (specific.permissionDecision !== 'allow' && specific.permissionDecision !== 'deny') {
        return { error: 'permissionDecision 只能是 allow 或 deny' }
      }
      output.permissionDecision = specific.permissionDecision
    }
    if (specific.permissionDecisionReason !== undefined) {
      if (typeof specific.permissionDecisionReason !== 'string') {
        return { error: 'permissionDecisionReason 必须是字符串' }
      }
      output.permissionDecisionReason = specific.permissionDecisionReason
    }
    if (specific.updatedInput !== undefined) {
      if (!isPlainObject(specific.updatedInput)) return { error: 'updatedInput 必须是对象' }
      output.updatedInput = specific.updatedInput
    }
    if (specific.additionalContext !== undefined) {
      if (typeof specific.additionalContext !== 'string') return { error: 'additionalContext 必须是字符串' }
      output.additionalContext = specific.additionalContext
    }
    if (specific.updatedOutput !== undefined) {
      if (typeof specific.updatedOutput !== 'string') return { error: 'updatedOutput 必须是字符串' }
      output.updatedOutput = specific.updatedOutput
    }
  }

  return output
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstText(...parts: string[]): string {
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function collectOutput(
  stream: NodeJS.ReadableStream | null,
  onTruncated: () => void,
): { text: string; truncated: boolean } {
  const sink = { text: '', truncated: false }
  if (!stream) return sink
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    if (sink.truncated) return
    sink.text += chunk
    if (sink.text.length > MAX_COMMAND_OUTPUT_CHARS) {
      sink.text = sink.text.slice(0, MAX_COMMAND_OUTPUT_CHARS)
      sink.truncated = true
      // 已经超限就停掉。只截断缓存的话,脚本还会继续往管道里灌。
      onTruncated()
    }
  })
  return sink
}

function killChild(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // /T 连子进程一起杀。shell: true 时 pid 是 cmd.exe,只杀它的话 node 脚本还在跑。
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已经没了
    }
  }
}
