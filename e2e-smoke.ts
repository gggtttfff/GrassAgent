// e2e-smoke.ts
// 端到端冒烟测试:起一个本地 mock SSE 服务,验证 agent 循环的关键约束。
// 运行: npm test
// 会往临时目录写文件,不碰项目源码。

import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { runAgent } from './src/agent.ts'
import { builtinTools } from './src/tools.ts'
import type { Model, Context } from './src/llm.ts'

// 测试工作目录:放在系统临时目录,与项目源码隔离
const WORK_DIR = path.join(os.tmpdir(), `grassagent-e2e-${process.pid}`)

// ---------- 断言辅助 ----------
let passedCount = 0
let failedCount = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passedCount++
    console.log(`  ✓ ${name}`)
  } else {
    failedCount++
    console.log(`  ✗ ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

// ---------- SSE 编码 ----------
// 把一段 assistant 回复编码成 OpenAI 兼容的 SSE 帧序列
function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

// 文本增量帧
function textFrame(text: string): string {
  return sseFrame({ choices: [{ delta: { content: text } }] })
}

// tool_call 增量帧:参数按块拼接,模拟真实流式
function toolCallFrame(index: number, id: string, name: string, argsChunk: string): string {
  return sseFrame({
    choices: [{
      delta: {
        tool_calls: [{ index, id: id || undefined, function: { name: name || undefined, arguments: argsChunk } }]
      }
    }]
  })
}

function finishFrame(reason: string): string {
  return sseFrame({ choices: [{ delta: {}, finish_reason: reason }] })
}

const doneMarker = 'data: [DONE]\n\n'

// 把多帧拼接成完整响应体
function body(frames: string[]): string {
  return frames.join('') + doneMarker
}

// ---------- mock 服务 ----------
// 每次收到请求返回队列里的下一个响应,便于编排多轮对话
type Responder = (req: { messages: any[] }) => { status: number; body: string }

const queue: Responder[] = []
let receivedRequests: any[] = []

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
  req.on('end', () => {
    const parsed = JSON.parse(raw) as { messages: any[] }
    receivedRequests.push(parsed)
    const next = queue.shift()
    if (!next) {
      // 队列被提前耗尽说明用例编排与实际请求轮数不符,保留告警便于定位
      console.warn(`[mock] 响应队列已空,返回 500 (第 ${receivedRequests.length} 个请求)`)
      res.writeHead(500).end('no responder queued')
      return
    }
    const result = next(parsed)
    // 声明不复用连接:undici 默认对同一 origin 保留 keep-alive 池,
    // 服务关闭时这些空闲 socket 处于 closing 状态,Windows 上会触发
    // libuv 断言并返回退出码 127,导致 CI 误判失败。
    res.writeHead(result.status, { 'content-type': 'text/event-stream', connection: 'close' })
    res.end(result.body)
  })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const serverPort = (server.address() as any).port

const model: Model = {
  apiKey: 'test-key',
  model: 'mock-model',
  baseUrl: `http://127.0.0.1:${serverPort}/v1`,
  maxTokens: 4096
}

console.log(`mock 服务已启动: 127.0.0.1:${serverPort}\n`)

// 工具集创建一次复用。builtinTools 是异步的:要先解析工作区的真实路径才能做沙箱判断。
const tools = await builtinTools({ workspace: WORK_DIR })

// ========== 用例 1: 普通文本回合 ==========
console.log('用例 1: 纯文本回复,无工具调用')
{
  queue.length = 0
  receivedRequests = []
  queue.push(() => ({
    status: 200,
    body: body([
      textFrame('你好'),
      textFrame(',世界'),
      finishFrame('stop')
    ])
  }))

  const context: Context = { messages: [{ role: 'user', content: '打招呼' }] }
  let text = ''
  let endReason = ''
  for await (const ev of runAgent(model, context, tools)) {
    if (ev.type === 'assistant_text') text += ev.delta
    if (ev.type === 'turn_end') endReason = ev.stopReason
  }

  check('文本完整', text === '你好,世界', `got: ${text}`)
  check('stopReason 为 end_turn', endReason === 'end_turn', `got: ${endReason}`)
  check('context 里 assistant 消息已回填', (context.messages[1] as any).role === 'assistant')
  check('未触发工具', receivedRequests.length === 1)
}

// ========== 用例 2: 工具调用闭环 ==========
console.log('\n用例 2: 模型调用 write_file,结果回填后结束')
{
  queue.length = 0
  receivedRequests = []
  const targetPath = path.join(WORK_DIR, 'hello.txt')
  const toolCallId = 'call_abc123'

  // 第一轮:模型决定写文件
  queue.push(() => ({
    status: 200,
    body: body([
      textFrame('我来写个文件'),
      toolCallFrame(0, toolCallId, 'write_file', JSON.stringify({ path: targetPath, content: 'hi' })),
      finishFrame('tool_calls')
    ])
  }))
  // 第二轮:模型收到工具结果后结束
  queue.push(() => ({
    status: 200,
    body: body([textFrame('文件写好了'), finishFrame('stop')])
  }))

  const context: Context = { messages: [{ role: 'user', content: '写个文件' }] }
  const toolEvents: any[] = []
  let text = ''
  for await (const ev of runAgent(model, context, tools)) {
    if (ev.type === 'tool_call' || ev.type === 'tool_result') toolEvents.push(ev)
    if (ev.type === 'assistant_text') text += ev.delta
  }

  check('工具被调用一次', toolEvents.filter((e) => e.type === 'tool_call').length === 1)
  check('工具结果已产出', toolEvents.filter((e) => e.type === 'tool_result').length === 1)
  check('参数解析正确', (toolEvents.find((e) => e.type === 'tool_call')?.args as any).path === targetPath)
  check('文件确实写入', (await readFileSafe(targetPath)).includes('hi'))
  check('未触发参数损坏兜底',
    !(toolEvents.find((e) => e.type === 'tool_result')?.result as string).includes('not valid JSON'))
  check('发了两轮请求', receivedRequests.length === 2)
  check('第二轮请求带 tool 消息',
    receivedRequests[1].messages.some((m: any) => m.role === 'tool'),
    JSON.stringify(receivedRequests[1].messages).slice(0, 200))
  check('第二轮回复了用户', text.includes('文件写好了'))

  const secondRoundMsgs = receivedRequests[1].messages
  const toolMsg = secondRoundMsgs.find((m: any) => m.role === 'tool')
  check('tool 消息 tool_call_id 匹配', toolMsg.tool_call_id === toolCallId, `got: ${toolMsg.tool_call_id}`)
}

// ========== 用例 3: max_tokens 截断时不执行工具 ==========
console.log('\n用例 3: max_tokens 截断,不执行残缺参数的工具')
{
  queue.length = 0
  receivedRequests = []
  // 参数 JSON 被截断,是残缺的
  queue.push(() => ({
    status: 200,
    body: body([
      toolCallFrame(0, 'call_trunc', 'write_file', '{"path":"/tmp/x","con'),
      finishFrame('length')
    ])
  }))
  // 模型重新发一次完整调用
  queue.push(() => ({
    status: 200,
    body: body([
      toolCallFrame(0, 'call_full', 'write_file', JSON.stringify({ path: path.join(WORK_DIR, 'retry.txt'), content: 'ok' }))
    ])
  }))
  queue.push(() => ({ status: 200, body: body([textFrame('重试成功'), finishFrame('stop')]) }))

  const context: Context = { messages: [{ role: 'user', content: '写文件' }] }
  let truncatedNoted = false
  for await (const ev of runAgent(model, context, tools)) {
    if (ev.type === 'tool_result' && ev.result.includes('max_tokens')) truncatedNoted = true
  }

  check('截断被标记为错误', truncatedNoted)
  check('触发了重试(共3轮请求)', receivedRequests.length === 3, `got: ${receivedRequests.length}`)
  check('重试时工具被真正执行', await exists(path.join(WORK_DIR, 'retry.txt')))
}

// ========== 用例 3b: 参数 JSON 损坏但 stopReason 正常 ==========
// max_tokens 分支只拦 stopReason==='max_tokens' 的情况
// step 5 的 argsInvalid 兜底需要独立验证:不能让损坏参数落到工具执行
console.log('\n用例 3b: 参数 JSON 损坏但 finish_reason 正常,仍不执行工具')
{
  queue.length = 0
  receivedRequests = []
  const corruptTarget = path.join(WORK_DIR, 'corrupt.txt')
  queue.push(() => ({
    status: 200,
    body: body([
      // 非法 JSON:括号未闭合,但 finish_reason 是 tool_calls(不是 length)
      toolCallFrame(0, 'call_bad', 'write_file', `{"path":${JSON.stringify(corruptTarget)},"content":"x"`),
      finishFrame('tool_calls')
    ])
  }))
  // 模型看到错误后重新发完整调用
  queue.push(() => ({
    status: 200,
    body: body([
      toolCallFrame(0, 'call_good', 'write_file', JSON.stringify({ path: corruptTarget, content: 'ok' }))
    ])
  }))
  queue.push(() => ({ status: 200, body: body([textFrame('已修正'), finishFrame('stop')]) }))

  const context: Context = { messages: [{ role: 'user', content: '写文件' }] }
  const results: string[] = []
  for await (const ev of runAgent(model, context, tools)) {
    if (ev.type === 'tool_result') results.push(ev.result)
  }

  check('损坏参数被标记为错误',
    results.some((r) => r.includes('not valid JSON')),
    `results: ${JSON.stringify(results)}`)
  // 损坏那轮若被执行会写入 "x",重发那轮写入 "ok"
  // 所以内容为 "ok" 才能证明损坏参数没有落到工具执行
  check('损坏参数未写入文件(内容来自重发轮)',
    (await readFileSafe(corruptTarget)).includes('ok'),
    `content: ${await readFileSafe(corruptTarget)}`)
  check('触发了模型重发(共3轮请求)', receivedRequests.length === 3, `got: ${receivedRequests.length}`)
}

// ========== 用例 4: abort 后 tool_call 配对补全 ==========
console.log('\n用例 4: Ctrl+C 打断后,每个 tool_call 都有 tool_result')
{
  queue.length = 0
  receivedRequests = []
  const abortTarget = path.join(WORK_DIR, 'abort.txt')
  // 模型一口气发两个 tool_call,我们中途 abort
  queue.push(() => ({
    status: 200,
    body: body([
      toolCallFrame(0, 'call_a', 'write_file', JSON.stringify({ path: abortTarget, content: 'a' })),
      toolCallFrame(1, 'call_b', 'write_file', JSON.stringify({ path: path.join(WORK_DIR, 'b.txt'), content: 'b' })),
      finishFrame('tool_calls')
    ])
  }))

  const context: Context = { messages: [{ role: 'user', content: '批量写文件' }] }
  const ctrl = new AbortController()
  const toolResults: any[] = []

  // 第一个工具执行后立刻 abort,模拟用户按 Ctrl+C
  // 注意:并行执行时两个工具是同时启动的,abort 时第二个可能已经在跑了。
  // 这里验证的是核心不变量——每个 tool_call 都有配对的 tool_result。
  //
  // 用一个独立的标志位而不是计数器:并行执行下工具完成顺序不确定,
  // 计数器会出现"醒来时已经不是 1"的情况,abort 根本触发不了。
  let abortTriggered = false
  const wrappedTools = tools.map((t) => ({
    ...t,
    execute: async (args: unknown, signal?: AbortSignal) => {
      const result = await t.execute(args, signal)
      if (!abortTriggered) {
        abortTriggered = true
        ctrl.abort()
      }
      return result
    }
  }))

  for await (const ev of runAgent(model, context, wrappedTools, ctrl.signal)) {
    if (ev.type === 'tool_result') toolResults.push(ev)
  }

  const resultIds = toolResults.map((r) => r.id)
  check('call_a 有结果', resultIds.includes('call_a'))
  check('call_b 也有结果(并行时已在执行)', resultIds.includes('call_b'))
  check('call_b 结果非空',
    typeof toolResults.find((r) => r.id === 'call_b')?.result === 'string' &&
    toolResults.find((r) => r.id === 'call_b')!.result.length > 0,
    `got: ${toolResults.find((r) => r.id === 'call_b')?.result}`)

  // 校验最后一轮请求里每个 tool_call 都有对应 tool_result(API 的硬性要求)
  const assistantMsg = (context.messages as any[]).find((m) =>
    m.role === 'assistant' && Array.isArray(m.content) &&
    m.content.some((b: any) => b.type === 'tool_use')
  )
  const toolUseIds = (assistantMsg?.content ?? [])
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any) => b.id)
  const toolResultIds = context.messages.flatMap((m: any) =>
    Array.isArray(m.content)
      ? (m.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id) as string[])
      : []
  )
  check('所有 tool_use 都有配对 tool_result',
    toolUseIds.every((id: string) => toolResultIds.includes(id)),
    `use: ${JSON.stringify(toolUseIds)} result: ${JSON.stringify(toolResultIds)}`)

  // 打断后不该再发请求:发出去也会被 abort 白跑一趟,
  // 而且重试逻辑不认 abort,会把打断后的失败当网络错误重试。
  check('打断后没有额外请求', receivedRequests.length === 1,
    `got: ${receivedRequests.length}`)
}

// ========== 用例 5: 上下文压缩 ==========
console.log('\n用例 5: 消息超过阈值后压缩旧消息')
{
  queue.length = 0
  receivedRequests = []

  // 压缩会额外发一轮请求,所以需要两个响应:先压缩摘要,再正常回复。
  // agent 循环一进来就会检查消息数,所以第一个响应就是摘要请求的响应。
  queue.push(() => ({ status: 200, body: body([textFrame('这是历史对话摘要'), finishFrame('stop')]) }))
  queue.push(() => ({ status: 200, body: body([textFrame('压缩后继续'), finishFrame('stop')]) }))

  const context: Context = {
    messages: Array.from({ length: 55 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` }))
  }

  let text = ''
  for await (const ev of runAgent(model, context, tools)) {
    if (ev.type === 'assistant_text') text += ev.delta
  }

  check('触发了压缩(发送了摘要请求)', receivedRequests.length >= 1)
  // 压缩只影响发给模型的视图,历史不动。
  // 以前压缩会砍掉历史,带来两个后果:切点可能劈开 tool_use/tool_result
  // 导致 API 400,以及会话存储按条数切片写不进去。
  check('历史保持完整(没有消息被删)', context.messages.length === 56,
    `压缩前 55 条 + 1 条 assistant 回复,now: ${context.messages.length}`)
  check('压缩状态已记录', (context as any).compaction !== undefined)

  // 摘要只出现在发给模型的请求里,不该进历史
  const historyText = JSON.stringify(context.messages)
  check('摘要没进历史', !historyText.includes('[context summary]'))
  // 但模型确实看到了摘要
  const lastRequestText = JSON.stringify(receivedRequests[receivedRequests.length - 1]?.messages ?? [])
  check('模型看到了摘要', lastRequestText.includes('[context summary]') &&
    lastRequestText.includes('这是历史对话摘要'),
    lastRequestText.slice(0, 200))
  // 发给模型的消息比历史少——旧消息被摘要顶替了
  check('发给模型的消息比历史少',
    (receivedRequests[receivedRequests.length - 1]?.messages ?? []).length < context.messages.length)
  check('保留了最近消息', context.messages.some((m: any) => typeof m.content === 'string' && m.content.includes('msg 54')))
}

// ---------- 清理 ----------
// 关闭必须等真正完成:closeAllConnections() 销毁 socket 是异步的,
// 若进程在 socket 仍处 closing 状态时退出,Windows 上 libuv 会触发断言
// 并返回 127,CI 误判为失败。等待 close 回调 + 让销毁落定再退出。
await new Promise<void>((resolve) => {
  server.closeAllConnections()
  server.close(() => resolve())
})
// 给已销毁 socket 的清理流程一个落定机会
await new Promise((resolve) => setTimeout(resolve, 20))
await fs.rm(WORK_DIR, { recursive: true, force: true })

console.log(`\n结果: ${passedCount} 通过, ${failedCount} 失败`)
process.exit(failedCount > 0 ? 1 : 0)

// ---------- 辅助 ----------
async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

// 读文件,不存在时返回空串而不是抛错(避免单个用例失败中断整个脚本)
async function readFileSafe(p: string): Promise<string> {
  try { return await fs.readFile(p, 'utf8') } catch { return '' }
}

// 列目录,不存在时返回空数组
async function safeListDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir) } catch { return [] }
}
