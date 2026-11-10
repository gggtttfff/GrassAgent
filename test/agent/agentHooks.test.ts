import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { runAgent, type AgentTool, type AgentEvent } from '../../src/agent/agent.ts'
import { createHookRunner, type HookHandler } from '../../src/agent/hooks.ts'
import type { Model, Context } from '../../src/llm/llm.ts'
import type { Message } from '../../src/llm/messages.ts'

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

async function startMockServer(responders: Responder[]): Promise<{ server: Server; port: number; requests: () => number }> {
  const queue = [...responders]
  let requestCount = 0
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      requestCount += 1
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
  return { server, port, requests: () => requestCount }
}

async function stopMockServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

const valueSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
}

function recordingTool(name = 'record_tool'): { tool: AgentTool; executed: unknown[] } {
  const executed: unknown[] = []
  const tool: AgentTool = {
    name,
    description: '记录参数',
    parameters: valueSchema,
    execute: async (args) => {
      executed.push(args)
      return 'ok'
    },
  }
  return { tool, executed }
}

function modelAt(port: number): Model {
  return { apiKey: 'test', model: 'mock', baseUrl: `http://127.0.0.1:${port}/v1` }
}

function runner(handler: HookHandler, event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | 'PreCompact' = 'PreToolUse') {
  return createHookRunner([
    { event, handler },
  ], { sessionId: 's', cwd: process.cwd(), defaultTimeoutMs: 1000 })
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

test('PreToolUse 拒绝时工具不执行,错误回填后模型还能继续', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ value: 'a' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('改口了'), finishFrame('stop')]) },
  ])
  try {
    const { tool, executed } = recordingTool()
    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    const events = await collect(runAgent(modelAt(mock.port), context, [tool], undefined, {
      hooks: runner(() => ({ decision: 'block', reason: '先别写' })),
    }))
    const results = events.filter((event) => event.type === 'tool_result')
    assert.equal(results.length, 1)
    assert.match(results[0].type === 'tool_result' ? results[0].result : '', /blocked by hook: 先别写/)
    assert.deepEqual(executed, [])
    assert.equal(mock.requests(), 2)
    assert.ok(events.some((event) => event.type === 'turn_end' && event.stopReason === 'end_turn'))
  } finally {
    await stopMockServer(mock.server)
  }
})

test('钩子改写的参数会传给工具,并写进历史', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ value: 'a' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('好'), finishFrame('stop')]) },
  ])
  try {
    const { tool, executed } = recordingTool()
    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    await collect(runAgent(modelAt(mock.port), context, [tool], undefined, {
      hooks: runner(() => ({ updatedInput: { value: 'b' } })),
    }))
    assert.deepEqual(executed, [{ value: 'b' }])
    const assistant = context.messages.find((message) => message.role === 'assistant')
    const toolUse = toolUseInput(assistant)
    assert.deepEqual(toolUse, { value: 'b' })
  } finally {
    await stopMockServer(mock.server)
  }
})

test('钩子能补上原本不合法的参数', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({})),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('好'), finishFrame('stop')]) },
  ])
  try {
    const { tool, executed } = recordingTool()
    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    await collect(runAgent(modelAt(mock.port), context, [tool], undefined, {
      hooks: runner(() => ({ updatedInput: { value: '补上了' } })),
    }))
    assert.deepEqual(executed, [{ value: '补上了' }])
  } finally {
    await stopMockServer(mock.server)
  }
})

test('钩子改写的参数仍然要过校验', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ value: 'a' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('好'), finishFrame('stop')]) },
  ])
  try {
    const { tool, executed } = recordingTool()
    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    const events = await collect(runAgent(modelAt(mock.port), context, [tool], undefined, {
      hooks: runner(() => ({ updatedInput: {} })),
    }))
    assert.deepEqual(executed, [])
    const result = events.find((event) => event.type === 'tool_result')
    assert.ok(result && result.type === 'tool_result')
    assert.match(result.result, /参数校验失败/)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('PostToolUse 可以改写回给模型的结果', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ value: 'a' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('好'), finishFrame('stop')]) },
  ])
  try {
    const { tool } = recordingTool()
    const hooks = createHookRunner([
      { event: 'PostToolUse', handler: () => ({ updatedOutput: '改写后的结果', additionalContext: '再看一眼' }) },
    ], { sessionId: 's', cwd: process.cwd(), defaultTimeoutMs: 1000 })
    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    const events = await collect(runAgent(modelAt(mock.port), context, [tool], undefined, { hooks }))
    const result = events.find((event) => event.type === 'tool_result')
    assert.ok(result && result.type === 'tool_result')
    assert.match(result.result, /改写后的结果/)
    assert.match(result.result, /再看一眼/)
    const toolResult = lastToolResult(context)
    assert.match(toolResult, /改写后的结果/)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('被拒绝的工具不再跑 PostToolUseFailure', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ value: 'a' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('好'), finishFrame('stop')]) },
  ])
  try {
    let postFailure = 0
    const { tool } = recordingTool()
    const hooks = createHookRunner([
      { event: 'PreToolUse', handler: () => ({ decision: 'block', reason: '停' }) },
      { event: 'PostToolUseFailure', handler: () => { postFailure += 1 } },
      { event: 'PostToolUse', handler: () => { postFailure += 1 } },
    ], { sessionId: 's', cwd: process.cwd(), defaultTimeoutMs: 1000 })
    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    await collect(runAgent(modelAt(mock.port), context, [tool], undefined, { hooks }))
    assert.equal(postFailure, 0)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('continue=false 时工具照跑,但不再问模型', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'record_tool', JSON.stringify({ value: 'a' })),
        finishFrame('tool_calls'),
      ]),
    },
  ])
  try {
    const { tool, executed } = recordingTool()
    const context: Context = { messages: [{ role: 'user', content: '调用' }] }
    const events = await collect(runAgent(modelAt(mock.port), context, [tool], undefined, {
      hooks: runner(() => ({ continue: false })),
    }))
    assert.deepEqual(executed, [{ value: 'a' }])
    assert.equal(mock.requests(), 1)
    assert.ok(events.some((event) => event.type === 'turn_end' && event.stopReason === 'end_turn'))
  } finally {
    await stopMockServer(mock.server)
  }
})

test('Stop 钩子可以把回合拉回来,并受次数上限约束', async () => {
  const mock = await startMockServer([
    { status: 200, body: body([textFrame('第一次'), finishFrame('stop')]) },
    { status: 200, body: body([textFrame('第二次'), finishFrame('stop')]) },
  ])
  try {
    let stops = 0
    const hooks = createHookRunner([
      {
        event: 'Stop',
        handler: () => {
          stops += 1
          return { decision: 'block', reason: '还没做完' }
        },
      },
    ], { sessionId: 's', cwd: process.cwd(), defaultTimeoutMs: 1000 })
    const context: Context = { messages: [{ role: 'user', content: '继续' }] }
    const events = await collect(runAgent(modelAt(mock.port), context, [], undefined, {
      hooks,
      maxStopContinuations: 1,
    }))
    assert.equal(stops, 1)
    assert.equal(mock.requests(), 2)
    assert.ok(events.some((event) => event.type === 'hook_notice' && event.message.includes('上限')))
    const hookMessage = context.messages.find((message) => (
      message.role === 'user' && typeof message.content === 'string' && message.content.includes('还没做完')
    ))
    assert.ok(hookMessage)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('PreCompact 拒绝时不压缩', async () => {
  const mock = await startMockServer([
    { status: 200, body: body([textFrame('可见回复'), finishFrame('stop')]) },
  ])
  try {
    let compactChecks = 0
    const hooks = createHookRunner([
      {
        event: 'PreCompact',
        handler: () => {
          compactChecks += 1
          return { decision: 'block', reason: '先别压' }
        },
      },
    ], { sessionId: 's', cwd: process.cwd(), defaultTimeoutMs: 1000 })
    const messages: Message[] = []
    for (let index = 0; index < 6; index++) {
      messages.push({ role: 'user', content: `旧消息 ${index} ${'内容'.repeat(20)}` })
    }
    const context: Context = { messages }
    const events = await collect(runAgent(modelAt(mock.port), context, [], undefined, {
      hooks,
      compaction: { contextWindow: 40, reserveTokens: 24, keepRecentTokens: 8 },
    }))
    assert.equal(compactChecks, 1)
    assert.equal(context.compaction, undefined)
    assert.equal(mock.requests(), 1)
    assert.ok(events.some((event) => event.type === 'assistant_text' && event.delta === '可见回复'))
  } finally {
    await stopMockServer(mock.server)
  }
})

test('同一轮里 PreToolUse 按模型给出的顺序跑', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'alpha', JSON.stringify({ value: '1' })),
        toolCallFrame(1, 'call_2', 'beta', JSON.stringify({ value: '2' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('好'), finishFrame('stop')]) },
  ])
  try {
    const seen: string[] = []
    const alpha = recordingTool('alpha')
    const beta = recordingTool('beta')
    const hooks = createHookRunner([
      {
        event: 'PreToolUse',
        handler: (input) => {
          seen.push(input.tool_name ?? '')
        },
      },
    ], { sessionId: 's', cwd: process.cwd(), defaultTimeoutMs: 1000 })
    const context: Context = { messages: [{ role: 'user', content: '两个' }] }
    await collect(runAgent(modelAt(mock.port), context, [alpha.tool, beta.tool], undefined, {
      hooks,
      toolExecution: 'parallel',
    }))
    assert.deepEqual(seen, ['alpha', 'beta'])
    assert.equal(alpha.executed.length, 1)
    assert.equal(beta.executed.length, 1)
  } finally {
    await stopMockServer(mock.server)
  }
})

function toolUseInput(message: Message | undefined): unknown {
  if (!message || !Array.isArray(message.content)) return undefined
  const block = message.content.find((item) => item.type === 'tool_use')
  return block && block.type === 'tool_use' ? block.input : undefined
}

function lastToolResult(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]
    if (!Array.isArray(message.content)) continue
    const block = message.content.find((item) => item.type === 'tool_result')
    if (block && block.type === 'tool_result') return block.content
  }
  return ''
}
