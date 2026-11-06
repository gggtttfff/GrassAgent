import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { runAgent } from '../src/agent.ts'
import type { AgentTool } from '../src/agent.ts'
import type { Model, Context } from '../src/llm.ts'

// 并行工具执行的测试。
// 核心不变量:每个 tool_call 都有配对的 tool_result,且顺序与原始顺序一致。

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
}> {
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

// 记录执行时序的工具
function createTimingTool(name: string, durationMs: number): { tool: AgentTool; getStartTimes: () => number[] } {
  const startTimes: number[] = []
  const tool: AgentTool = {
    name,
    description: `耗时 ${durationMs}ms 的工具`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      startTimes.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, durationMs))
      return `${name} 完成`
    },
  }
  return { tool, getStartTimes: () => startTimes }
}

test('并行的工具确实同时执行', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'slow_tool', '{}'),
        toolCallFrame(1, 'call_2', 'slow_tool', '{}'),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const { tool, getStartTimes } = createTimingTool('slow_tool', 200)

    const context: Context = { messages: [{ role: 'user', content: '并行' }] }
    const startedAt = Date.now()
    for await (const event of runAgent(model, context, [tool], undefined, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') break
    }
    const elapsed = Date.now() - startedAt

    assert.equal(getStartTimes().length, 2, '两个工具都该执行')
    // 串行需要 400ms,并行约 200ms。留出余量,机器慢一点也能过
    assert.ok(elapsed < 350, `并行应明显快于串行,实际 ${elapsed}ms`)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('串行模式下工具依次执行', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'slow_tool', '{}'),
        toolCallFrame(1, 'call_2', 'slow_tool', '{}'),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const { tool } = createTimingTool('slow_tool', 150)

    const context: Context = { messages: [{ role: 'user', content: '串行' }] }
    const startedAt = Date.now()
    for await (const event of runAgent(model, context, [tool], undefined, { toolExecution: 'sequential' })) {
      if (event.type === 'turn_end') break
    }
    const elapsed = Date.now() - startedAt

    // 串行两个各 150ms,至少 300ms
    assert.ok(elapsed >= 280, `串行应至少 300ms,实际 ${elapsed}ms`)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('结果顺序与 tool_call 原始顺序一致', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'slow_tool', '{}'),
        toolCallFrame(1, 'call_2', 'fast_tool', '{}'),
        toolCallFrame(2, 'call_3', 'slow_tool', '{}'),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const { tool: slowTool } = createTimingTool('slow_tool', 120)
    const { tool: fastTool } = createTimingTool('fast_tool', 10)

    const context: Context = { messages: [{ role: 'user', content: '顺序' }] }
    const resultIds: string[] = []
    for await (const event of runAgent(model, context, [slowTool, fastTool], undefined, { toolExecution: 'parallel' })) {
      if (event.type === 'tool_result') resultIds.push(event.id)
    }

    assert.deepEqual(resultIds, ['call_1', 'call_2', 'call_3'], '事件顺序应与原始顺序一致')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('abort 后每个 tool_call 仍有配对的 tool_result', async () => {
  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'slow_tool', '{}'),
        toolCallFrame(1, 'call_2', 'slow_tool', '{}'),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const controller = new AbortController()

    // 用标志位而不是计数器:并行执行下工具完成顺序不确定,
    // 计数器会出现"醒来时已经不是 1"的情况,abort 根本触发不了。
    let abortTriggered = false
    const tool: AgentTool = {
      name: 'slow_tool',
      description: '慢工具',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        if (!abortTriggered) {
          abortTriggered = true
          controller.abort()
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
        return '完成'
      },
    }

    const context: Context = { messages: [{ role: 'user', content: '中断' }] }
    for await (const event of runAgent(model, context, [tool], controller.signal, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') break
    }

    // 核心不变量:每个 tool_use 都要有配对的 tool_result
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

test('abort 后不再发新的请求', async () => {
  // 打断发生在工具执行期间时,工具跑完不该再去问模型。
  // 发出去的请求也会被 abort 白跑一趟,重试逻辑还会把它当网络错误重试。
  let requestCount = 0
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      requestCount++
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(body([
        toolCallFrame(0, 'call_1', 'slow_tool', '{}'),
        finishFrame('tool_calls'),
      ]))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${port}/v1` }
    const controller = new AbortController()

    const tool: AgentTool = {
      name: 'slow_tool',
      description: '慢工具',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 30))
        return '完成'
      },
    }

    const context: Context = { messages: [{ role: 'user', content: '中断' }] }
    let stopReason = ''
    for await (const event of runAgent(model, context, [tool], controller.signal, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') stopReason = event.stopReason
    }

    assert.equal(stopReason, 'aborted', '回合应以 aborted 结束')
    assert.equal(requestCount, 1, `打断后不该再发请求,实际发了 ${requestCount} 个`)
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
})

test('修改同一文件的工具串行执行,不会丢更新', async () => {
  // 模拟两个 edit 改同一个文件:如果并发,第二个会读到旧内容,覆盖第一个的修改
  // 注意:不要在工具内部再包 withFileMutationQueue——agent 层已经包了一层,
  // 同一个 key 的队列会自己等自己,死锁。这里只模拟"读-改-写"的竞态窗口。
  const fileContents = new Map<string, string>([['target.txt', 'start']])

  const tool: AgentTool = {
    name: 'edit_tool',
    description: '修改文件',
    parameters: { type: 'object', properties: {}, required: [] },
    mutatesFiles: ['path'],
    execute: async (args) => {
      const filePath = (args as { path: string }).path
      // 模拟"读-改-写"之间有延迟,放大竞态窗口
      const current = fileContents.get(filePath) ?? ''
      await new Promise((resolve) => setTimeout(resolve, 20))
      fileContents.set(filePath, `${current}+1`)
      return 'ok'
    },
  }

  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'edit_tool', JSON.stringify({ path: 'target.txt' })),
        toolCallFrame(1, 'call_2', 'edit_tool', JSON.stringify({ path: 'target.txt' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: [{ role: 'user', content: '改文件' }] }
    for await (const event of runAgent(model, context, [tool], undefined, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') break
    }

    // 两个修改都要保留:结果应该是 start+1+1,而不是 start+1
    assert.equal(fileContents.get('target.txt'), 'start+1+1', '并发修改同一文件会丢更新')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('一个工具改多个文件时,每个文件都会被串行化', async () => {
  // 声明了多个路径的工具必须锁住全部路径。
  // 只锁第一个的话,第二个文件上的并发写就会互相覆盖。
  const directory = path.join(os.tmpdir(), `grassagent-multi-${process.pid}-${Date.now()}`)
  await fs.mkdir(directory, { recursive: true })

  const firstFile = path.join(directory, 'first.txt')
  const secondFile = path.join(directory, 'second.txt')

  const tool: AgentTool = {
    name: 'multi_edit_tool',
    description: '同时改两个文件',
    parameters: { type: 'object', properties: {}, required: [] },
    mutatesFiles: ['paths'],
    execute: async (args) => {
      const paths = (args as { paths: string[] }).paths
      // 读-改-写之间有延迟,放大竞态窗口
      const contents = await Promise.all(paths.map(async (filePath) => {
        const current = await fs.readFile(filePath, 'utf-8').catch(() => '')
        await new Promise((resolve) => setTimeout(resolve, 20))
        return [filePath, current] as const
      }))
      for (const [filePath, current] of contents) {
        await fs.writeFile(filePath, `${current}+1`, 'utf-8')
      }
      return 'ok'
    },
  }

  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'multi_edit_tool', JSON.stringify({ paths: [firstFile, secondFile] })),
        toolCallFrame(1, 'call_2', 'multi_edit_tool', JSON.stringify({ paths: [firstFile, secondFile] })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: [{ role: 'user', content: '改两个文件' }] }
    for await (const event of runAgent(model, context, [tool], undefined, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') break
    }

    // 两个文件的修改都要保留
    assert.equal(await fs.readFile(firstFile, 'utf-8'), '+1+1', '第一个文件的修改丢了')
    assert.equal(await fs.readFile(secondFile, 'utf-8'), '+1+1', '第二个文件的修改丢了')
  } finally {
    await stopMockServer(mock.server)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('修改不同文件的工具并行执行', async () => {
  let concurrentPeak = 0
  let active = 0

  const tool: AgentTool = {
    name: 'edit_tool',
    description: '修改文件',
    parameters: { type: 'object', properties: {}, required: [] },
    mutatesFiles: ['path'],
    execute: async () => {
      active++
      concurrentPeak = Math.max(concurrentPeak, active)
      await new Promise((resolve) => setTimeout(resolve, 50))
      active--
      return 'ok'
    },
  }

  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'edit_tool', JSON.stringify({ path: 'a.txt' })),
        toolCallFrame(1, 'call_2', 'edit_tool', JSON.stringify({ path: 'b.txt' })),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: [{ role: 'user', content: '改不同文件' }] }
    for await (const event of runAgent(model, context, [tool], undefined, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') break
    }

    assert.ok(concurrentPeak >= 2, `不同文件应并行执行,实际峰值 ${concurrentPeak}`)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('未声明 mutatesFiles 的工具自由并发', async () => {
  let concurrentPeak = 0
  let active = 0

  const tool: AgentTool = {
    name: 'read_tool',
    description: '读文件',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      active++
      concurrentPeak = Math.max(concurrentPeak, active)
      await new Promise((resolve) => setTimeout(resolve, 50))
      active--
      return 'ok'
    },
  }

  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'read_tool', '{}'),
        toolCallFrame(1, 'call_2', 'read_tool', '{}'),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: [{ role: 'user', content: '读' }] }
    for await (const event of runAgent(model, context, [tool], undefined, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') break
    }

    assert.ok(concurrentPeak >= 2, `未声明 mutatesFiles 的工具应并发,实际峰值 ${concurrentPeak}`)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('声明 sequential 的工具不和其他工具并发', async () => {
  // sequential 的意思是"这个工具必须单独跑"。
  // 不管有没有声明 mutatesFiles,别的工具都不能和它同时执行。
  const events: string[] = []

  const sequentialTool: AgentTool = {
    name: 'sequential_tool',
    description: '必须单独跑',
    parameters: { type: 'object', properties: {}, required: [] },
    sequential: true,
    execute: async () => {
      events.push('sequential 开始')
      await new Promise((resolve) => setTimeout(resolve, 40))
      events.push('sequential 结束')
      return 'ok'
    },
  }

  const normalTool: AgentTool = {
    name: 'normal_tool',
    description: '普通工具',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      events.push('normal 开始')
      await new Promise((resolve) => setTimeout(resolve, 40))
      events.push('normal 结束')
      return 'ok'
    },
  }

  const mock = await startMockServer([
    {
      status: 200,
      body: body([
        toolCallFrame(0, 'call_1', 'normal_tool', '{}'),
        toolCallFrame(1, 'call_2', 'sequential_tool', '{}'),
        toolCallFrame(2, 'call_3', 'normal_tool', '{}'),
        finishFrame('tool_calls'),
      ]),
    },
    { status: 200, body: body([textFrame('完成'), finishFrame('stop')]) },
  ])

  try {
    const model: Model = { apiKey: 'k', model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }
    const context: Context = { messages: [{ role: 'user', content: '混合' }] }
    for await (const event of runAgent(model, context, [sequentialTool, normalTool], undefined, { toolExecution: 'parallel' })) {
      if (event.type === 'turn_end') break
    }

    // sequential 工具的起止之间不能有别的工具在跑
    const sequentialStart = events.indexOf('sequential 开始')
    const sequentialEnd = events.indexOf('sequential 结束')
    const inside = events.slice(sequentialStart + 1, sequentialEnd)
    assert.ok(sequentialStart >= 0 && sequentialEnd > sequentialStart, `事件顺序不对: ${events.join(',')}`)
    assert.ok(
      inside.every((entry) => entry.startsWith('sequential')),
      `sequential 工具执行期间不该有别的工具,实际: ${events.join(',')}`,
    )
  } finally {
    await stopMockServer(mock.server)
  }
})
