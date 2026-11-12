import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { parseApprovalDecision, createModelApprover } from '../../src/agent/approval.ts'
import { runAgent, type AgentTool, type Approver } from '../../src/agent/agent.ts'
import type { Context, Model } from '../../src/llm/llm.ts'

test('解析两行结论和 JSON 结论', () => {
  assert.deepEqual(
    parseApprovalDecision('decision: allow\nreason: 用户明确要求写入'),
    { allowed: true, reason: '用户明确要求写入' },
  )
  assert.deepEqual(
    parseApprovalDecision('说明一下\n{"decision":"deny","reason":"会删掉整个目录"}'),
    { allowed: false, reason: '会删掉整个目录' },
  )
  assert.equal(parseApprovalDecision('我觉得可以'), null)
  assert.equal(parseApprovalDecision(''), null)
})

function createTool(requiresApproval: boolean): { tool: AgentTool; executed: { count: number } } {
  const executed = { count: 0 }
  const tool: AgentTool = {
    name: 'write_file',
    description: '写入',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    requiresApproval,
    execute: async () => {
      executed.count += 1
      return 'wrote'
    },
  }
  return { tool, executed }
}

function sseBody(frames: string[]): string {
  return frames.join('') + 'data: [DONE]\n\n'
}

function toolFrame(): string {
  const payload = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.ts' }) },
        }],
      },
    }],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

function finishFrame(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`
}

function textFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

async function startMock(bodies: string[]): Promise<{ port: number; close: () => Promise<void> }> {
  const queue = [...bodies]
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      const next = queue.shift() ?? sseBody([textFrame('done'), finishFrame('stop')])
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(next)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

async function runOnce(
  port: number,
  tool: AgentTool,
  approve: Approver,
): Promise<{ results: string[]; permissions: Array<{ allowed: boolean; reason: string }> }> {
  const model: Model = { apiKey: 'k', model: 'primary', baseUrl: `http://127.0.0.1:${port}/v1` }
  const context: Context = { messages: [{ role: 'user', content: '把 a.ts 写上注释' }] }
  const results: string[] = []
  const permissions: Array<{ allowed: boolean; reason: string }> = []
  for await (const event of runAgent(model, context, [tool], undefined, { approve })) {
    if (event.type === 'tool_result') results.push(event.result)
    if (event.type === 'permission') permissions.push({ allowed: event.allowed, reason: event.reason })
  }
  return { results, permissions }
}

test('审批拒绝时工具不执行,理由回填给主力模型', async () => {
  const mock = await startMock([
    sseBody([toolFrame(), finishFrame('tool_calls')]),
    sseBody([textFrame('已停下'), finishFrame('stop')]),
  ])
  const { tool, executed } = createTool(true)
  try {
    const { results, permissions } = await runOnce(mock.port, tool, async () => ({
      allowed: false,
      reason: '会覆盖现有实现',
    }))
    assert.equal(executed.count, 0)
    assert.equal(permissions[0]?.allowed, false)
    assert.ok(results[0]?.includes('permission denied'))
    assert.ok(results[0]?.includes('会覆盖现有实现'))
  } finally {
    await mock.close()
  }
})

test('审批通过后才执行工具', async () => {
  const mock = await startMock([
    sseBody([toolFrame(), finishFrame('tool_calls')]),
    sseBody([textFrame('写完了'), finishFrame('stop')]),
  ])
  const { tool, executed } = createTool(true)
  try {
    const { results, permissions } = await runOnce(mock.port, tool, async (request) => {
      assert.equal(request.toolName, 'write_file')
      assert.equal(request.userIntent, '把 a.ts 写上注释')
      return { allowed: true, reason: '和用户要求一致' }
    })
    assert.equal(executed.count, 1)
    assert.equal(permissions[0]?.allowed, true)
    assert.equal(results[0], 'wrote')
  } finally {
    await mock.close()
  }
})

test('不需要审批的工具不会去问审批器', async () => {
  const mock = await startMock([
    sseBody([toolFrame(), finishFrame('tool_calls')]),
    sseBody([textFrame('读完了'), finishFrame('stop')]),
  ])
  const { tool, executed } = createTool(false)
  try {
    await runOnce(mock.port, tool, async () => {
      throw new Error('不该被调用')
    })
    assert.equal(executed.count, 1)
  } finally {
    await mock.close()
  }
})

test('审批器抛错时拒绝执行', async () => {
  const mock = await startMock([
    sseBody([toolFrame(), finishFrame('tool_calls')]),
    sseBody([textFrame('停下'), finishFrame('stop')]),
  ])
  const { tool, executed } = createTool(true)
  try {
    const { results } = await runOnce(mock.port, tool, async () => {
      throw new Error('审批服务挂了')
    })
    assert.equal(executed.count, 0)
    assert.ok(results[0]?.includes('permission denied'))
  } finally {
    await mock.close()
  }
})

test('审批模型的输出解析不了就拒绝', async () => {
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(sseBody([textFrame('可以吧大概'), finishFrame('stop')]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const approve = createModelApprover({
      apiKey: 'k',
      model: 'approval',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    })
    const decision = await approve({ toolName: 'run_bash', args: { command: 'rm -rf .' }, userIntent: '看看目录' })
    assert.equal(decision.allowed, false)
    assert.match(decision.reason, /无法解析/)
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
})
