import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// 非交互模式的端到端测试。
//
// 场景:管道输入(printf 'xxx' | grassagent)。
// stdin 不是 TTY,界面不能挂死,也不能把一行文本当成按键序列。
// 回合必须能跑完,输出不能有 ANSI 残留,进程要正常退出。
//
// 用子进程跑真实入口——这是唯一能验证完整链路的 way。

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// 起一个 mock SSE 服务,返回一个固定回复
async function startMockServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(
        'data: {"choices":[{"delta":{"content":"回复**加粗**内容"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// 跑一次 CLI,喂给它一行输入,收集输出
async function runCliWithInput(
  input: string,
  environment: Record<string, string>,
): Promise<{ exitCode: number; output: string }> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join('src', 'cli.ts')],
    {
      cwd: projectRoot,
      env: { ...process.env, ...environment },
      // stdin 保持 pipe:写完一行就 end,模拟管道输入
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })

  child.stdin.write(input)
  child.stdin.end()

  const exitCode = await new Promise<number>((resolve) => {
    // 超时兜底:挂死了不能一直等
    const timer = setTimeout(() => {
      child.kill()
      resolve(-1)
    }, 20000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 0)
    })
  })

  return { exitCode, output }
}

test('非交互模式能跑完整个回合并正常退出', async () => {
  const mock = await startMockServer()
  try {
    const { exitCode, output } = await runCliWithInput('测试输入\n', {
      GRASSAGENT_API_KEY: 'test-key',
      GRASSAGENT_MODEL: 'mock-model',
      GRASSAGENT_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      GRASSAGENT_SESSION_DATABASE_PATH: ':memory:',
      GRASSAGENT_LOG_FORMAT: 'json',
    })

    assert.equal(exitCode, 0, `应正常退出,实际 ${exitCode}`)
    // 模型回复要出现——回合确实跑完了,不是提前退出的
    assert.ok(output.includes('回复'), `输出里应有模型回复,实际: ${output.slice(-300)}`)
    // markdown 的星号被渲染掉了
    assert.ok(output.includes('加粗'), `markdown 应被渲染,实际: ${output.slice(-300)}`)
    assert.ok(!output.includes('**'), 'markdown 标记应被渲染掉')
  } finally {
    await mock.close()
  }
})

test('非交互模式的输出没有 ANSI 控制序列', async () => {
  const mock = await startMockServer()
  try {
    const { output } = await runCliWithInput('再测一次\n', {
      GRASSAGENT_API_KEY: 'test-key',
      GRASSAGENT_MODEL: 'mock-model',
      GRASSAGENT_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      GRASSAGENT_SESSION_DATABASE_PATH: ':memory:',
      GRASSAGENT_LOG_FORMAT: 'json',
    })

    // stdout 不是 TTY 时,渲染层产出的 ANSI 序列要清掉——
    // 输出重定向到文件时它们就是乱码。
    // 日志行本身不含 ANSI,先排掉日志再检查渲染部分。
    const rendered = output
      .split('\n')
      .filter((line) => !line.startsWith('{"level"'))
      .join('\n')

    assert.ok(!rendered.includes('\x1b['), `输出里不该有 ANSI 序列,实际: ${JSON.stringify(rendered.slice(0, 200))}`)
  } finally {
    await mock.close()
  }
})

// 斜杠命令的端到端测试。
//
// 关键断言:命令在本地执行,不发给模型。
// 未知命令也得拦下来——不然会被当成普通输入发给模型。

const mockEnvironment = (port: number): Record<string, string> => ({
  GRASSAGENT_API_KEY: 'test-key',
  GRASSAGENT_MODEL: 'mock-model',
  GRASSAGENT_BASE_URL: `http://127.0.0.1:${port}/v1`,
  GRASSAGENT_SESSION_DATABASE_PATH: ':memory:',
  GRASSAGENT_LOG_FORMAT: 'json',
})

test('斜杠命令在本地执行,不发给模型', async () => {
  const mock = await startMockServer()
  try {
    const { exitCode, output } = await runCliWithInput('/clear\n', mockEnvironment(mock.port))

    assert.equal(exitCode, 0)
    assert.ok(output.includes('对话已清空'), `应该提示清空成功,实际: ${output.slice(-300)}`)
    // 关键:模型没被调用
    assert.ok(!output.includes('回复'), '命令不该发给模型')
  } finally {
    await mock.close()
  }
})

test('未知命令给出提示,也不发给模型', async () => {
  const mock = await startMockServer()
  try {
    const { exitCode, output } = await runCliWithInput('/nope\n', mockEnvironment(mock.port))

    assert.equal(exitCode, 0)
    assert.ok(output.includes('未知命令'), `应该提示未知命令,实际: ${output.slice(-300)}`)
    assert.ok(!output.includes('回复'), '拼错的命令不该发给模型')
  } finally {
    await mock.close()
  }
})

test('/sessions 列出会话', async () => {
  const mock = await startMockServer()
  try {
    const { exitCode, output } = await runCliWithInput('/sessions\n', mockEnvironment(mock.port))

    assert.equal(exitCode, 0)
    assert.ok(/session/i.test(output), `应该列出会话 ID,实际: ${output.slice(-300)}`)
    assert.ok(!output.includes('回复'), '命令不该发给模型')
  } finally {
    await mock.close()
  }
})

test('普通输入照常发给模型', async () => {
  const mock = await startMockServer()
  try {
    const { exitCode, output } = await runCliWithInput('普通问题\n', mockEnvironment(mock.port))

    assert.equal(exitCode, 0)
    assert.ok(output.includes('回复'), `普通输入应该发给模型,实际: ${output.slice(-300)}`)
  } finally {
    await mock.close()
  }
})
