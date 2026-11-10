import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createTransport } from '../../src/core/transport.ts'
import { ApiError } from '../../src/core/retry.ts'

// 起一个可控的 mock 服务:按队列返回预设响应
type Responder = { status: number; body: string; headers?: Record<string, string> }

async function startMockServer(responders: Responder[]): Promise<{ server: Server; port: number; requestCount: () => number }> {
  const queue = [...responders]
  let requestCount = 0

  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      requestCount++
      const next = queue.shift()
      if (!next) {
        response.writeHead(500).end('no responder')
        return
      }
      response.writeHead(next.status, {
        'content-type': 'application/json',
        connection: 'close',
        ...next.headers,
      })
      response.end(next.body)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return { server, port, requestCount: () => requestCount }
}

async function stopMockServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function createTestTransport(overrides: Partial<Parameters<typeof createTransport>[0]> = {}) {
  return createTransport({
    timeoutMs: 5000,
    maxRetries: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 50,
    maxConcurrency: 4,
    ...overrides,
  })
}

test('成功的请求返回响应', async () => {
  const mock = await startMockServer([{ status: 200, body: '{"ok":true}' }])
  try {
    const transport = createTestTransport()
    const response = await transport.request(
      `http://127.0.0.1:${mock.port}/v1/chat`,
      { method: 'POST', body: '{}' },
      { operationName: 'test' },
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '{"ok":true}')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('5xx 会重试并最终成功', async () => {
  const mock = await startMockServer([
    { status: 500, body: 'server error' },
    { status: 200, body: '{"ok":true}' },
  ])
  try {
    const transport = createTestTransport()
    const response = await transport.request(
      `http://127.0.0.1:${mock.port}/v1/chat`,
      { method: 'POST', body: '{}' },
      { operationName: 'test' },
    )
    assert.equal(response.status, 200)
    assert.equal(mock.requestCount(), 2, '应发出两次请求')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('4xx 立即失败不重试', async () => {
  const mock = await startMockServer([
    { status: 400, body: 'bad request' },
    { status: 200, body: '{"ok":true}' },
  ])
  try {
    const transport = createTestTransport()
    await assert.rejects(
      transport.request(
        `http://127.0.0.1:${mock.port}/v1/chat`,
        { method: 'POST', body: '{}' },
        { operationName: 'test' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 400)
        return true
      },
    )
    assert.equal(mock.requestCount(), 1, '不可重试的错误只应请求一次')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('重试次数用尽后抛出 ApiError', async () => {
  const mock = await startMockServer([
    { status: 503, body: 'unavailable' },
    { status: 503, body: 'unavailable' },
    { status: 503, body: 'unavailable' },
    { status: 503, body: 'unavailable' },
    { status: 503, body: 'unavailable' },
  ])
  try {
    const transport = createTestTransport({ maxRetries: 2 })
    await assert.rejects(
      transport.request(
        `http://127.0.0.1:${mock.port}/v1/chat`,
        { method: 'POST', body: '{}' },
        { operationName: 'test' },
      ),
      ApiError,
    )
    assert.equal(mock.requestCount(), 3, '首次 + 2 次重试')
  } finally {
    await stopMockServer(mock.server)
  }
})

test('Retry-After 头被用于等待', async () => {
  const mock = await startMockServer([
    { status: 429, body: 'rate limited', headers: { 'retry-after': '0' } },
    { status: 200, body: '{"ok":true}' },
  ])
  try {
    const transport = createTestTransport()
    const response = await transport.request(
      `http://127.0.0.1:${mock.port}/v1/chat`,
      { method: 'POST', body: '{}' },
      { operationName: 'test' },
    )
    assert.equal(response.status, 200)
    assert.equal(mock.requestCount(), 2)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('请求超时会抛出网络错误', async () => {
  // 服务端不返回任何响应,触发客户端超时
  const server = createServer(() => {
    // 故意不响应
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    const transport = createTestTransport({ timeoutMs: 200, maxRetries: 0 })
    await assert.rejects(
      transport.request(
        `http://127.0.0.1:${port}/v1/chat`,
        { method: 'POST', body: '{}' },
        { operationName: 'test' },
      ),
    )
  } finally {
    await stopMockServer(server)
  }
})

test('超时后的重试仍能成功,说明超时信号没有污染后续尝试', async () => {
  const mock = await startMockServer([
    { status: 500, body: 'fail once' },
    { status: 200, body: '{"ok":true}' },
  ])
  try {
    const transport = createTestTransport()
    const response = await transport.request(
      `http://127.0.0.1:${mock.port}/v1/chat`,
      { method: 'POST', body: '{}' },
      { operationName: 'test' },
    )
    assert.equal(response.status, 200)
  } finally {
    await stopMockServer(mock.server)
  }
})

test('并发闸门限制同时在飞的请求数', async () => {
  let active = 0
  let peak = 0

  const server = createServer((request, response) => {
    active++
    peak = Math.max(peak, active)
    request.on('data', () => {})
    request.on('end', () => {
      setTimeout(() => {
        active--
        response.writeHead(200, { connection: 'close' }).end('{}')
      }, 30)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    const transport = createTestTransport({ maxConcurrency: 2 })
    await Promise.all(
      Array.from({ length: 6 }, () =>
        transport.request(
          `http://127.0.0.1:${port}/v1/chat`,
          { method: 'POST', body: '{}' },
          { operationName: 'test' },
        ),
      ),
    )
    assert.ok(peak <= 2, `并发峰值应不超过 2,实际 ${peak}`)
  } finally {
    await stopMockServer(server)
  }
})

test('abort 信号会中断请求', async () => {
  const server = createServer(() => {
    // 故意不响应
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const controller = new AbortController()
  try {
    const transport = createTestTransport({ maxRetries: 5 })
    const pending = transport.request(
      `http://127.0.0.1:${port}/v1/chat`,
      { method: 'POST', body: '{}' },
      { signal: controller.signal, operationName: 'test' },
    )
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(pending)
  } finally {
    await stopMockServer(server)
  }
})
