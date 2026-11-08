import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { runAgent } from '../src/agent.ts'
import { builtinTools } from '../src/tools.ts'
import type { Model, Context } from '../src/llm.ts'

// ask_user 的测试。
// 关键:回答是 tool_result,不是新的 user 消息;等待回答时也能被 Ctrl+C 打断。

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function toolCallFrame(index: number, id: string, name: string, argsChunk: string): string {
  return sseFrame({
    choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: argsChunk } }] } }],
  })
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

async function startMockServer(responses: string[]): Promise<{
  server: Server
  port: number
  receivedRequests: Array<{ messages: Array<{ role: string; content: unknown }> }>
}> {
  const queue = [...responses]
  const receivedRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      receivedRequests.push(JSON.parse(raw))
      const next = queue.shift()
      if (!next) {
        response.writeHead(400).end('no responder')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(next)
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

test('没有注入提问界面时不注册 ask_user', async () => {
  const tools = await builtinTools()
  assert.equal(tools.find((tool) => tool.name === 'ask_user'), undefined)
})

test('ask_user 把问题交给界面并返回用户回答', async () => {
  let askedQuestion = ''
  const tools = await builtinTools({
    askUser: async (question) => {
      askedQuestion = question
      return '使用 TypeScript'
    },
  })
  const tool = tools.find((item) => item.name === 'ask_user')
  assert.ok(tool)

  const answer = await tool.execute({ question: '  用什么语言?  ' })
  assert.equal(askedQuestion, '用什么语言?')
  assert.equal(answer, '使用 TypeScript')
})

test('空问题不调用界面', async () => {
  let called = false
  const tools = await builtinTools({
    askUser: async () => {
      called = true
      return '不该到这里'
    },
  })
  const tool = tools.find((item) => item.name === 'ask_user')
  assert.ok(tool)

  assert.match(await tool.execute({ question: '   ' }), /must not be empty/)
  assert.equal(called, false)
})

test('ask_user 必须单独执行', async () => {
  const tools = await builtinTools({ askUser: async () => '回答' })
  const tool = tools.find((item) => item.name === 'ask_user')
  // 同时只能有一个问题,而且回答可能决定其他工具该不该执行
  assert.equal(tool?.sequential, true)
})

test('完整回合:提问 → 用户回答 → 结果回填 → 再问模型', async () => {
  const mock = await startMockServer([
    body([
      toolCallFrame(0, 'call_ask', 'ask_user', JSON.stringify({ question: '使用什么语言?' })),
      finishFrame('tool_calls'),
    ]),
    body([textFrame('收到,使用 TypeScript'), finishFrame('stop')]),
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const tools = await builtinTools({ askUser: async () => 'TypeScript' })
    const context: Context = { messages: [{ role: 'user', content: '帮我写个脚本' }] }
    const results: string[] = []

    for await (const event of runAgent(model, context, tools)) {
      if (event.type === 'tool_result') results.push(event.result)
    }

    assert.deepEqual(results, ['TypeScript'])
    assert.equal(mock.receivedRequests.length, 2)
    const secondRequest = JSON.stringify(mock.receivedRequests[1].messages)
    assert.ok(secondRequest.includes('TypeScript'), '第二次请求应该带上用户回答')
    assert.ok(secondRequest.includes('call_ask'), '工具结果应该和提问的 tool_call 配对')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('等待回答时 abort 会结束回合,不再发请求', async () => {
  const mock = await startMockServer([
    body([
      toolCallFrame(0, 'call_ask', 'ask_user', JSON.stringify({ question: '要继续吗?' })),
      finishFrame('tool_calls'),
    ]),
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const controller = new AbortController()
    const tools = await builtinTools({
      askUser: async (_question, signal) => {
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          setTimeout(() => controller.abort(), 20)
        })
      },
    })
    const context: Context = { messages: [{ role: 'user', content: '开始' }] }
    let stopReason = ''

    for await (const event of runAgent(model, context, tools, controller.signal)) {
      if (event.type === 'turn_end') stopReason = event.stopReason
    }

    assert.equal(stopReason, 'aborted')
    assert.equal(mock.receivedRequests.length, 1, '打断后不该再问模型')
    const toolUseIds = context.messages.flatMap((message) => {
      if (typeof message.content === 'string') return []
      return message.content.filter((block) => block.type === 'tool_use').map((block) => block.id)
    })
    const toolResultIds = context.messages.flatMap((message) => {
      if (typeof message.content === 'string') return []
      return message.content.filter((block) => block.type === 'tool_result').map((block) => block.tool_use_id)
    })
    assert.deepEqual(toolResultIds, toolUseIds, '打断后也要保留配对的 tool_result')
  } finally {
    await stopMockServer(mock.server)
  }
})
