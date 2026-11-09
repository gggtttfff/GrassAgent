import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { normalizeTitle, generateSessionTitle, ensureSessionTitle } from '../src/sessionTitle.ts'

test('标题去掉引号、markdown 和多余说明', () => {
  assert.equal(normalizeTitle('  「修登录」  \n这是解释'), '修登录')
  assert.equal(normalizeTitle('**加粗标题**'), '加粗标题')
  assert.equal(normalizeTitle('标题: 看日志'), '看日志')
  assert.equal(normalizeTitle('   \n  '), null)
})

test('标题超长时截断', () => {
  const title = normalizeTitle('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十超出')
  assert.equal(title?.length, 32)
})

test('小模型的输出被收成标题', async () => {
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(
        'data: {"choices":[{"delta":{"content":"\\"排查超时\\""},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    const title = await generateSessionTitle(
      { apiKey: 'k', model: 'small', baseUrl: `http://127.0.0.1:${port}/v1` },
      '接口偶尔超时,帮我看一下',
    )
    assert.equal(title, '排查超时')
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
})

test('已经有标题时不再请求模型', async () => {
  let called = false
  const store = {
    getTitle: () => '已有',
    setTitle: () => { called = true },
  }
  const title = await ensureSessionTitle({
    store,
    model: { apiKey: 'k', model: 'small', baseUrl: 'http://127.0.0.1:1/v1' },
    userText: '新的一句',
  })
  assert.equal(title, null)
  assert.equal(called, false)
})
