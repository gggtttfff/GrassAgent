import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { validateConfig } from '../../src/config.ts'
import { buildModelRoster } from '../../src/llm/modelRoster.ts'
import { runAgent } from '../../src/agent/agent.ts'
import type { Context } from '../../src/llm/messages.ts'

test('没单独配置时,小模型和审批模型继承主力模型', () => {
  const roster = buildModelRoster(validateConfig({ ApiKey: 'k', Model: 'primary-model' }))

  assert.equal(roster.primary.model, 'primary-model')
  assert.equal(roster.small.model, 'primary-model')
  assert.equal(roster.small.apiKey, 'k')
  assert.equal(roster.small.baseUrl, roster.primary.baseUrl)
  assert.equal(roster.small.maxTokens, roster.primary.maxTokens)
  assert.equal(roster.approval.model, 'primary-model')
  // 审批结论很短,缺省不沿用主力模型的大上限
  assert.equal(roster.approval.maxTokens, 512)
})

test('三个角色可以指向不同的模型和地址', () => {
  const roster = buildModelRoster(validateConfig({
    ApiKey: 'primary-key',
    Model: 'primary-model',
    BaseUrl: 'https://primary.example/v1',
    MaxTokens: '4096',
    SmallModel: 'small-model',
    SmallBaseUrl: 'http://127.0.0.1:11434/v1',
    SmallApiKey: 'small-key',
    SmallMaxTokens: '1024',
    ApprovalModel: 'approval-model',
    ApprovalBaseUrl: 'https://approval.example/v1',
    ApprovalApiKey: 'approval-key',
    ApprovalMaxTokens: '128',
  }))

  assert.equal(roster.primary.model, 'primary-model')
  assert.equal(roster.primary.apiKey, 'primary-key')
  assert.equal(roster.small.model, 'small-model')
  assert.equal(roster.small.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(roster.small.apiKey, 'small-key')
  assert.equal(roster.small.maxTokens, 1024)
  assert.equal(roster.approval.model, 'approval-model')
  assert.equal(roster.approval.baseUrl, 'https://approval.example/v1')
  assert.equal(roster.approval.apiKey, 'approval-key')
  assert.equal(roster.approval.maxTokens, 128)
})

test('小模型地址不合法时指出对应的环境变量', () => {
  assert.throws(
    () => validateConfig({ ApiKey: 'k', SmallBaseUrl: 'not-a-url' }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes('配置校验失败') || ('issues' in error))
      const issues = (error as { issues?: string[] }).issues ?? []
      assert.ok(issues.some((issue) => issue.includes('GRASSAGENT_SMALL_BASE_URL')))
      return true
    },
  )
})

function sse(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n'
}

async function startServer(): Promise<{ server: Server; port: number; models: string[] }> {
  const models: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { model?: string }
      models.push(body.model ?? '')
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(sse(models.length === 1 ? '摘要' : '答复'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { server, port, models }
}

test('压缩走小模型,对话走主力模型', async () => {
  const mock = await startServer()
  try {
    const baseUrl = `http://127.0.0.1:${mock.port}/v1`
    const context: Context = {
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: 'user' as const,
        content: `消息 ${index}`,
      })),
    }
    const events = []
    for await (const event of runAgent(
      { apiKey: 'k', model: 'primary-model', baseUrl },
      context,
      [],
      undefined,
      {
        compaction: { contextWindow: 12, reserveTokens: 6, keepRecentTokens: 2 },
        compactionModel: { apiKey: 'k', model: 'small-model', baseUrl },
      },
    )) {
      events.push(event.type)
    }

    assert.deepEqual(mock.models, ['small-model', 'primary-model'])
    assert.ok(events.includes('turn_end'))
    assert.equal(context.messages.length, 9, '压缩不该删历史,答复还要追加进去')
  } finally {
    await new Promise<void>((resolve) => {
      mock.server.closeAllConnections()
      mock.server.close(() => resolve())
    })
  }
})
