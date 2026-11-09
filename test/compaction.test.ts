import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  buildModelContext,
  buildModelMessages,
  compactContext,
  findSafeBoundary,
  hasOrphanToolResult,
} from '../src/compaction.ts'
import type { Context, Message } from '../src/messages.ts'
import type { Model } from '../src/llm.ts'

// 上下文压缩的测试。
//
// 核心不变量:压缩只影响发给模型的视图,历史永远完整,
// 而且切点不能劈开 tool_use 和 tool_result。

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function textFrame(text: string): string {
  return sseFrame({ choices: [{ delta: { content: text } }] })
}

function finishFrame(reason: string): string {
  return sseFrame({ choices: [{ delta: {}, finish_reason: reason }] })
}

function body(frames: string[]): string {
  return frames.join('') + 'data: [DONE]\n\n'
}

// 起一个 mock 服务,按顺序返回准备好的响应。
// status 是 400 而不是 500——500 属于可重试错误,会退避重试 3 次,
// 测试会慢好几秒。400 立即失败。
//
// 请求体记在 receivedRequests 里,用来验证压缩时发了什么。
async function startMockServer(
  responses: Array<{ status?: number; body: string }>,
): Promise<{ server: Server; port: number; receivedRequests: Array<{ messages: Array<{ content: unknown }> }> }> {
  const queue = [...responses]
  const receivedRequests: Array<{ messages: Array<{ content: unknown }> }> = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      try {
        receivedRequests.push(JSON.parse(raw))
      } catch {
        receivedRequests.push({ messages: [] })
      }
      const next = queue.shift()
      if (!next) {
        response.writeHead(400).end('no responder')
        return
      }
      response.writeHead(next.status ?? 200, {
        'content-type': 'text/event-stream',
        connection: 'close',
      })
      response.end(next.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, port, receivedRequests }
}

async function stopMockServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

// 造一条 tool_use 消息
function toolUseMessage(id: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'read_file', input: {} }],
  }
}

// 造一条 tool_result 消息
function toolResultMessage(id: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: '内容' }],
  }
}

// 造 N 条普通用户消息
function plainMessages(count: number, prefix = 'msg'): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user' as const,
    content: `${prefix} ${index}`,
  }))
}

// 压缩的默认参数
const compactionOptions = { threshold: 20, keepRecent: 10 }

test('hasOrphanToolResult 认出没有配对的 tool_result', () => {
  const orphan = [toolResultMessage('call_1')]
  const paired = [toolUseMessage('call_1'), toolResultMessage('call_1')]

  assert.equal(hasOrphanToolResult(orphan), true)
  assert.equal(hasOrphanToolResult(paired), false)
})

test('findSafeBoundary 把切点挪到不劈开工具调用的位置', () => {
  // tool_use 在 index 10,tool_result 在 index 11。
  // 切点落在 11 时保留区从 tool_result 开始——它会变成孤儿。
  const messages = [
    ...plainMessages(10),
    toolUseMessage('call_1'),
    toolResultMessage('call_1'),
    ...plainMessages(10),
  ]

  // 目标切点是 11,正好劈开这对调用
  const boundary = findSafeBoundary(messages, 11)
  assert.ok(boundary < 11, `切点应该往前挪,实际 ${boundary}`)

  // 挪完之后保留区里不能有落单的 tool_result
  assert.equal(hasOrphanToolResult(messages.slice(boundary)), false)
})

test('findSafeBoundary 切点本来就安全时不动它', () => {
  const messages = plainMessages(30)
  assert.equal(findSafeBoundary(messages, 10), 10)
})

test('buildModelMessages 没压缩过就原样返回', () => {
  const messages = plainMessages(5)
  const context = { messages }
  assert.deepEqual(buildModelMessages(context, null), messages)
  assert.deepEqual(buildModelMessages(context, undefined), messages)
})

test('buildModelMessages 用摘要替换已压缩的历史', () => {
  const messages = plainMessages(10)
  const context = { messages }

  const view = buildModelMessages(context, { summarizedCount: 6, summary: '摘要内容' })

  assert.equal(view.length, 5, '摘要一条 + 保留 4 条')
  assert.ok(String(view[0].content).includes('摘要内容'))
  assert.ok(String(view[0].content).includes('context summary'))
  // 历史本身没被动过
  assert.equal(context.messages.length, 10)
})

test('buildModelContext 保留系统提示词', () => {
  const context = { systemPrompt: '你是助手', messages: plainMessages(3) }
  const modelContext = buildModelContext(context, { summarizedCount: 1, summary: 'S' })

  assert.equal(modelContext.systemPrompt, '你是助手')
  assert.equal(modelContext.messages.length, 3)
})

test('压缩后历史保持完整,不会被摘要替换掉', async () => {
  const mock = await startMockServer([
    { body: body([textFrame('这是摘要'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: plainMessages(30) }

    await compactContext(model, context, undefined, {}, compactionOptions)

    // 历史一条没少
    assert.equal(context.messages.length, 30, '压缩不该删掉历史消息')
    // 压缩状态写进了 context
    assert.ok(context.compaction, '压缩状态应该写进 context')
    assert.ok(context.compaction!.summarizedCount > 0)
    assert.ok(context.compaction!.summary.includes('这是摘要'))
  } finally {
    await stopMockServer(mock.server)
  }
})

test('压缩的切点不劈开 tool_use 和 tool_result', async () => {
  const mock = await startMockServer([
    { body: body([textFrame('摘要'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    // tool_use 在压缩区,tool_result 在保留区——这是会把请求搞成 400 的布局
    const context: Context = {
      messages: [
        ...plainMessages(15),
        toolUseMessage('call_1'),
        toolResultMessage('call_1'),
        ...plainMessages(14),
      ],
    }

    await compactContext(model, context, undefined, {}, compactionOptions)

    assert.ok(context.compaction)
    // 切点之后不能有落单的 tool_result
    const view = buildModelMessages(context, context.compaction)
    assert.equal(hasOrphanToolResult(view), false, '发给模型的视图里有落单的 tool_result')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('压缩失败时保留原状态,不用空摘要', async () => {
  // 400 是不可重试错误,立即失败
  const mock = await startMockServer([
    { status: 400, body: 'bad request' },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: plainMessages(30) }

    await compactContext(model, context, undefined, {}, compactionOptions)

    assert.equal(context.compaction, undefined, '压缩失败不该留下状态')
    assert.equal(context.messages.length, 30, '压缩失败不该动历史')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('消息数没到阈值就不压缩', async () => {
  const mock = await startMockServer([])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: plainMessages(5) }

    await compactContext(model, context, undefined, {}, compactionOptions)

    assert.equal(context.compaction, undefined)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('abort 时不压缩', async () => {
  const mock = await startMockServer([])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: plainMessages(30) }
    const controller = new AbortController()
    controller.abort()

    await compactContext(model, context, controller.signal, {}, compactionOptions)

    assert.equal(context.compaction, undefined)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('已经摘要过的部分不会被重复摘要', async () => {
  const mock = await startMockServer([])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    // 前 25 条已经被摘要覆盖,只剩 5 条没摘要——不到阈值,不该再压
    const context: Context = {
      messages: plainMessages(30),
      compaction: { summarizedCount: 25, summary: '已有摘要' },
    }

    await compactContext(model, context, undefined, {}, compactionOptions)

    // 原来的状态没变
    assert.ok(context.compaction)
    assert.equal(context.compaction.summarizedCount, 25)
    assert.equal(context.compaction.summary, '已有摘要')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('第二次压缩会把上一次的摘要一起总结进去', async () => {
  const mock = await startMockServer([
    { body: body([textFrame('第一份摘要'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = {
      messages: plainMessages(40),
      compaction: { summarizedCount: 30, summary: '之前的摘要' },
    }

    await compactContext(model, context, undefined, {}, { threshold: 5, keepRecent: 5 })

    assert.ok(context.compaction)
    // 覆盖范围往前推进了
    assert.ok(context.compaction.summarizedCount > 30, '压缩范围应该继续往前推')

    // 压缩请求的内容里应该带上一次的摘要——
    // 只总结新增部分会把之前压缩掉的历史弄丢
    const summaryRequest = mock.receivedRequests[0]
    assert.ok(summaryRequest, '应该发过一次摘要请求')
    const requestText = JSON.stringify(summaryRequest.messages)
    assert.ok(
      requestText.includes('之前的摘要'),
      `摘要请求里应该带上旧摘要,实际: ${requestText.slice(0, 300)}`,
    )
  } finally {
    await stopMockServer(mock.server)
  }
})

test('小模型用 JSON 表示要压缩时,只留下摘要正文', async () => {
  const mock = await startMockServer([
    { body: body([textFrame('{"compact":true,"summary":"留下的决策"}'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'small', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: plainMessages(30) }

    await compactContext(model, context, undefined, {}, compactionOptions)

    assert.equal(context.compaction?.summary, '留下的决策')
    assert.ok((context.compaction?.summarizedCount ?? 0) > 0)
    const view = buildModelMessages(context, context.compaction)
    assert.ok(String(view[0].content).includes('留下的决策'))
    assert.equal(String(view[0].content).includes('compact'), false)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('小模型判断先不压缩时不写空摘要,短时间内也不再问', async () => {
  const mock = await startMockServer([
    { body: body([textFrame('{"compact":false,"summary":""}'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'small', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = {
      messages: plainMessages(30),
      compaction: { summarizedCount: 5, summary: '已有摘要' },
    }

    await compactContext(model, context, undefined, {}, compactionOptions)
    await compactContext(model, context, undefined, {}, compactionOptions)

    assert.equal(mock.receivedRequests.length, 1, '判断过先不压之后不该马上再问')
    assert.equal(context.compaction?.summarizedCount, 5, '不压缩就不该推进切点')
    assert.equal(context.compaction?.summary, '已有摘要', '不压缩不该清掉已有摘要')
    assert.ok((context.compaction?.deferUntilLength ?? 0) > context.messages.length)
    // 没有新摘要时视图仍用原来的摘要,而不是空的
    const view = buildModelMessages(context, context.compaction)
    assert.ok(String(view[0].content).includes('已有摘要'))
  } finally {
    await stopMockServer(mock.server)
  }
})

test('只有「先不压」记录时,发给模型的仍是完整历史', () => {
  const messages = plainMessages(4)
  const view = buildModelMessages(
    { messages },
    { summarizedCount: 0, summary: '', deferUntilLength: 20 },
  )
  assert.deepEqual(view, messages)
})
