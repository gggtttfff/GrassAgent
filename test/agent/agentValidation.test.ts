import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { runAgent } from '../../src/agent/agent.ts'
import type { Model, Context } from '../../src/llm/llm.ts'
import type { AgentTool } from '../../src/agent/agent.ts'

// 起一个 mock 服务,按队列返回预设的 SSE 响应
type Responder = { status: number; body: string }

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function toolCallFrame(index: number, id: string, name: string, argsChunk: string): string {
  return sseFrame({
    choices: [{
      delta: {
        tool_calls: [{ index, id, function: { name, arguments: argsChunk } }],
      },
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

async function startMockServer(responders: Responder[]): Promise<{ server: Server; port: number }> {
  const queue = [...responders]
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
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
  return { server, port }
}

async function stopMockServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

// 一个会记录是否被执行过的工具
function createRecordingTool(schema: object): { tool: AgentTool; executed: unknown[] } {
  const executed: unknown[] = []
  const tool: AgentTool = {
    name: 'record_tool',
    description: '记录参数',
    parameters: schema,
    execute: async (args) => {
      executed.push(args)
      return 'ok'
    },
  }
  return { tool, executed }
}

test('参数缺必填字段时工具不执行,错误回填给模型', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        // 第一次缺必填字段 value,应该被拦下
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ other: 'x' })),
        finishFrame('tool_calls'),
      ]),
    },
    // 模型看到错误后重发合法参数
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_2', 'record_tool', JSON.stringify({ value: '合法' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = {
      apiKey: 'test',
      model: 'mock',
      baseUrl: `http://127.0.0.1:${mock.port}/v1`,
    }
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
    const { tool, executed } = createRecordingTool(schema)

    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    const results: string[] = []
    for await (const event of runAgent(model, context, [tool])) {
      if (event.type === 'tool_result') results.push(event.result)
    }

    assert.equal(results.length, 2)
    assert.ok(results[0].includes('参数校验失败'), `实际: ${results[0]}`)
    assert.equal(results[1], 'ok')
    // 校验失败的那次不能真的执行了工具
    assert.equal(executed.length, 1, `实际执行 ${executed.length} 次`)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('参数被自动转换后传给工具', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        // count 传的是字符串,校验时应转成数字
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ count: '42' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = {
      apiKey: 'test',
      model: 'mock',
      baseUrl: `http://127.0.0.1:${mock.port}/v1`,
    }
    const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] }
    const { tool, executed } = createRecordingTool(schema)

    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    for await (const event of runAgent(model, context, [tool])) {
      if (event.type === 'turn_end') assert.equal(event.stopReason, 'end_turn')
    }

    assert.equal(executed.length, 1)
    assert.equal((executed[0] as { count: number }).count, 42, '工具应收到转换后的数字')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('校验失败时 tool_call 仍有配对的 tool_result', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({})),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = {
      apiKey: 'test',
      model: 'mock',
      baseUrl: `http://127.0.0.1:${mock.port}/v1`,
    }
    const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
    const { tool } = createRecordingTool(schema)

    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    for await (const event of runAgent(model, context, [tool])) {
      if (event.type === 'turn_end') break
    }

    // 每个 tool_use 都要有配对的 tool_result,否则下次恢复会话 API 会 400
    const toolUseIds = context.messages.flatMap((message) => {
      if (typeof message.content === 'string') return []
      return message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => (block as { id: string }).id)
    })
    const toolResultIds = context.messages.flatMap((message) => {
      if (typeof message.content === 'string') return []
      return message.content
        .filter((block) => block.type === 'tool_result')
        .map((block) => (block as { tool_use_id: string }).tool_use_id)
    })
    assert.ok(toolUseIds.length > 0)
    for (const id of toolUseIds) {
      assert.ok(toolResultIds.includes(id), `tool_use ${id} 缺少配对的 tool_result`)
    }
  } finally {
    await stopMockServer(mock.server)
  }
})
