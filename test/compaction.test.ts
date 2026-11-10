import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  buildModelContext,
  buildModelMessages,
  collectFileOperations,
  compactContext,
  estimateMessageTokens,
  findSafeBoundary,
  findTokenCut,
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

// 测试用的小窗口。短消息大约 2 token 一条,30 条会超过 40 的预算。
const compactionOptions = { contextWindow: 80, reserveTokens: 40, keepRecentTokens: 16 }

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

test('估算 token 用字符数除以 4,向上取整', () => {
  const message: Message = { role: 'user', content: 'x'.repeat(5) }
  assert.equal(estimateMessageTokens(message), 2)
})

test('长消息会触发压缩,同样条数的短消息不会', async () => {
  const mock = await startMockServer([
    { body: body([textFrame('长消息摘要'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const options = { contextWindow: 400, reserveTokens: 50, keepRecentTokens: 80 }
    const shortContext: Context = { messages: plainMessages(5) }
    await compactContext(model, shortContext, undefined, {}, options)
    assert.equal(shortContext.compaction, undefined, '短消息不该因为条数够了就压缩')

    const longContext: Context = {
      messages: Array.from({ length: 5 }, () => ({ role: 'user' as const, content: 'x'.repeat(400) })),
    }
    await compactContext(model, longContext, undefined, {}, options)
    assert.ok(longContext.compaction, '长消息应该按 token 触发压缩')
    assert.equal(longContext.messages.length, 5)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('token 切点落在 tool_result 上时会把 tool_use 一起留下', () => {
  const tail: Message = { role: 'user', content: 'x'.repeat(40) }
  const messages: Message[] = [
    { role: 'user', content: 'old' },
    toolUseMessage('call_1'),
    toolResultMessage('call_1'),
    tail,
  ]
  // 预算只比最后一条多 1,回走会踩到 tool_result,安全切点必须再往前
  const boundary = findTokenCut(messages, 0, estimateMessageTokens(tail) + 1)
  assert.equal(hasOrphanToolResult(messages.slice(boundary)), false)
  assert.ok(boundary <= 1, `tool_use 应该留在保留区,实际切点 ${boundary}`)
})

test('文件路径从工具调用里抽出,不靠摘要正文', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'r', name: 'read_file', input: { path: 'src/a.ts' } },
        { type: 'tool_use', id: 'w', name: 'edit', input: { path: 'src/b.ts' } },
        { type: 'tool_use', id: 'w2', name: 'edit', input: { path: 'src/b.ts' } },
      ],
    },
  ]
  const files = collectFileOperations(messages)
  assert.deepEqual(files.readFiles, ['src/a.ts'])
  assert.deepEqual(files.modifiedFiles, ['src/b.ts'])
})

test('压缩视图附上读过和改过的路径', async () => {
  const mock = await startMockServer([
    { body: body([textFrame('摘要正文'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'r', name: 'read_file', input: { path: 'src/a.ts' } },
            { type: 'tool_use', id: 'w', name: 'write_file', input: { path: 'src/b.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'r', content: 'a' },
            { type: 'tool_result', tool_use_id: 'w', content: 'wrote' },
          ],
        },
        ...plainMessages(20, 'tail'),
      ],
    }

    await compactContext(
      model,
      context,
      undefined,
      {},
      { contextWindow: 80, reserveTokens: 50, keepRecentTokens: 12 },
    )

    assert.ok(context.compaction)
    assert.deepEqual(context.compaction.readFiles, ['src/a.ts'])
    assert.deepEqual(context.compaction.modifiedFiles, ['src/b.ts'])
    const view = buildModelMessages(context, context.compaction)
    const summaryText = String(view[0].content)
    assert.ok(summaryText.includes('<read-files>'))
    assert.ok(summaryText.includes('src/a.ts'))
    assert.ok(summaryText.includes('src/b.ts'))
    assert.ok(!context.compaction.summary.includes('src/a.ts'), '路径不要写进摘要正文,下一轮合并时会重复')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('估算 token 没到阈值就不压缩', async () => {
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

    await compactContext(model, context, undefined, {}, { contextWindow: 40, reserveTokens: 24, keepRecentTokens: 8 })

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
    assert.ok(requestText.includes('previous-summary'), '旧摘要要单独成段,避免和新增对话混在一起')
    assert.ok(requestText.includes('只按指定格式输出'), '摘要请求不该接着回答对话')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('估算 token 时遇到嵌套过深的工具参数不会爆栈', () => {
  let input: unknown = { ok: true }
  for (let index = 0; index < 300; index++) input = { nested: input }
  const message: Message = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input }],
  }
  assert.equal(Number.isFinite(estimateMessageTokens(message)), true)
})
