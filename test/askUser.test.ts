import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { Writable } from 'node:stream'
import { runAgent, type AgentTool } from '../src/agent.ts'
import { ASK_USER_UNAVAILABLE, createAskUserTool, type UserReply } from '../src/askUser.ts'
import { createLogger } from '../src/logger.ts'
import { validateToolArguments } from '../src/validation.ts'
import type { Context, Model } from '../src/llm.ts'

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function toolCallFrame(index: number, id: string, name: string, argsChunk: string): string {
  return sseFrame({
    choices: [{
      delta: { tool_calls: [{ index, id, function: { name, arguments: argsChunk } }] },
    }],
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

async function startMockServer(responders: Array<{ status: number; body: string }>): Promise<{
  server: Server
  port: number
  requests: string[]
}> {
  const queue = [...responders]
  const requests: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf-8'))
      const next = queue.shift()
      if (!next) {
        response.writeHead(500).end('no responder')
        return
      }
      response.writeHead(next.status, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(next.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, port, requests }
}

async function stopMockServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function answered(answer: string): UserReply {
  return { status: 'answered', answer }
}

test('ask_user 声明为单独执行', () => {
  let called = false
  const tool = createAskUserTool({
    ask: async () => {
      called = true
      return answered('用 typescript')
    },
  })
  assert.equal(tool.name, 'ask_user')
  assert.equal(tool.sequential, true)
  assert.equal(called, false)
})

test('execute 返回用户的回答', async () => {
  const tool = createAskUserTool({
    ask: async (question) => {
      assert.equal(question, '用哪种语言')
      return answered('用 typescript')
    },
  })
  assert.equal(await tool.execute({ question: '用哪种语言' }), '用 typescript')
})

test('空白问题不拿去问用户', async () => {
  let called = false
  const tool = createAskUserTool({
    ask: async () => {
      called = true
      return answered('不该出现')
    },
  })
  const result = await tool.execute({ question: '   ' })
  assert.equal(called, false)
  assert.match(result, /不能为空/)
})

test('空问题过不了参数校验', () => {
  const tool = createAskUserTool({ ask: async () => answered('x') })
  const result = validateToolArguments(tool.parameters, { question: '' }, tool.name)
  assert.equal(result.ok, false)
})

test('打断时不调用提问，并返回 aborted', async () => {
  let called = false
  const tool = createAskUserTool({
    ask: async () => {
      called = true
      return answered('来不及')
    },
  })
  const controller = new AbortController()
  controller.abort()
  assert.equal(await tool.execute({ question: '还要继续吗' }, controller.signal), 'error:aborted')
  assert.equal(called, false)
})

test('等待期间被打断，结果是 aborted', async () => {
  const controller = new AbortController()
  const tool = createAskUserTool({
    ask: async (_question, signal) => {
      controller.abort()
      return signal?.aborted ? { status: 'aborted' } : answered('不该用到')
    },
  })
  assert.equal(await tool.execute({ question: '还要继续吗' }, controller.signal), 'error:aborted')
})

test('没有用户时把失败记进日志，并告诉模型不要再问', async () => {
  const lines: string[] = []
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })
  const logger = createLogger({ level: 'warn', format: 'json', destination: sink })
  const tool = createAskUserTool({
    ask: async () => ({ status: 'unavailable' }),
    logger,
  })
  const result = await tool.execute({ question: '用哪种语言' })
  assert.equal(result, ASK_USER_UNAVAILABLE)
  assert.match(result, /不要再调用 ask_user/)
  assert.match(lines.join(''), /用户无法回答提问/)
  assert.match(lines.join(''), /用哪种语言/)
})

test('回答会回到下一轮请求，并且不和别的工具重叠', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_ask', 'ask_user', '{"question":"用哪种语言"}'),
        toolCallFrame(1, 'call_other', 'other_tool', '{}'),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('那就用 typescript'), finishFrame('stop')]) },
  ])

  const events: string[] = []
  const askTool = createAskUserTool({
    ask: async () => {
      events.push('ask 开始')
      await new Promise((resolve) => setTimeout(resolve, 30))
      events.push('ask 结束')
      return answered('用 typescript')
    },
  })
  const otherTool: AgentTool = {
    name: 'other_tool',
    description: '另一个工具',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      events.push('other 开始')
      events.push('other 结束')
      return 'other 完成'
    },
  }

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: [{ role: 'user', content: '帮我选' }] }
    let finalText = ''
    for await (const event of runAgent(model, context, [askTool, otherTool])) {
      if (event.type === 'assistant_text') finalText += event.delta
      if (event.type === 'tool_result' && event.name === 'ask_user') {
        assert.equal(event.result, '用 typescript')
      }
    }

    assert.equal(finalText, '那就用 typescript')
    assert.deepEqual(events, ['ask 开始', 'ask 结束', 'other 开始', 'other 结束'])
    assert.equal(mock.requests.length, 2)
    const followUp = JSON.parse(mock.requests[1]) as { messages: Array<{ role: string; content: string | null }> }
    const toolMessage = followUp.messages.find((message) => message.role === 'tool')
    assert.equal(toolMessage?.content, '用 typescript')
    // 回答只出现在 tool 结果里。再塞一条 user 消息会让下一轮输入和这次回答叠在一起。
    const userMessages = followUp.messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 1)
    assert.equal(userMessages[0].content, '帮我选')
  } finally {
    await stopMockServer(mock.server)
  }
})
