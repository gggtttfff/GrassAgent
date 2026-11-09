import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

function quoteShell(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
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

test('UserPromptSubmit 可以拦住输入,退出时会跑 SessionEnd', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grass-cli-hooks-'))
  const scriptPath = path.join(directory, 'hook.mjs')
  const hooksPath = path.join(directory, 'hooks.json')
  const markerPath = path.join(directory, 'ended.txt')
  const command = `${quoteShell(process.execPath)} ${quoteShell(scriptPath)}`
  await writeFile(scriptPath, `
    import { writeFileSync } from 'node:fs'
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { raw += chunk })
    process.stdin.on('end', () => {
      const input = JSON.parse(raw || '{}')
      if (input.hook_event_name === 'UserPromptSubmit') {
        process.stderr.write('已被测试钩子拦截')
        process.exit(2)
      }
      if (input.hook_event_name === 'SessionEnd') {
        writeFileSync(process.env.GRASS_TEST_MARKER, 'ended')
      }
    })
  `)
  await writeFile(hooksPath, JSON.stringify({
    UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeoutMs: 5000 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command, timeoutMs: 5000 }] }],
  }))

  const mock = await startMockServer()
  try {
    const { exitCode, output } = await runCliWithInput('这条不该发给模型\n', {
      ...mockEnvironment(mock.port),
      GRASSAGENT_WORKSPACE: directory,
      GRASSAGENT_HOOKS_PATH: hooksPath,
      GRASS_TEST_MARKER: markerPath,
    })
    assert.equal(exitCode, 0, `应正常退出,实际 ${exitCode},输出: ${output.slice(-400)}`)
    assert.ok(output.includes('已被测试钩子拦截'), `应显示钩子拒绝原因,实际: ${output.slice(-400)}`)
    assert.ok(!output.includes('回复'), '被拦截的输入不该发给模型')
    assert.equal(await readFile(markerPath, 'utf8'), 'ended')
  } finally {
    await mock.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('模型提问时，下一行是回答，不会另开一轮', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf-8'))
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      if (requests.length === 1) {
        response.end(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ask","function":{"name":"ask_user","arguments":"{\\"question\\":\\"用哪种语言\\"}"}}]}}]}\n\n' +
            'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
            'data: [DONE]\n\n',
        )
        return
      }
      response.end(
        'data: {"choices":[{"delta":{"content":"已按你的选择继续"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    // 空行要被跳过，真正的回答才回给模型
    const { exitCode, output } = await runCliWithInput('帮我选\n\n用 typescript\n', mockEnvironment(port))
    assert.equal(exitCode, 0, `应正常退出,实际 ${exitCode},输出: ${output.slice(-400)}`)
    assert.ok(output.includes('? 用哪种语言'), `应显示问题,实际: ${output.slice(-400)}`)
    assert.ok(output.includes('已按你的选择继续'), `回答之后应继续回合,实际: ${output.slice(-400)}`)
    assert.equal(requests.length, 2, `回答不该再开一轮用户消息,实际请求数 ${requests.length}`)
    const followUp = JSON.parse(requests[1]) as {
      messages: Array<{ role: string; content?: string | null }>
    }
    const toolMessage = followUp.messages.find((message) => message.role === 'tool')
    assert.equal(toolMessage?.content, '用 typescript')
    const userMessages = followUp.messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 1)
    assert.equal(userMessages[0].content, '帮我选')
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
})

test('没有人回答时回合仍能结束并退出', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      requests.push('hit')
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      if (requests.length === 1) {
        response.end(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ask","function":{"name":"ask_user","arguments":"{\\"question\\":\\"用哪种语言\\"}"}}]}}]}\n\n' +
            'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
            'data: [DONE]\n\n',
        )
        return
      }
      response.end(
        'data: {"choices":[{"delta":{"content":"按现有信息继续"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    const { exitCode, output } = await runCliWithInput('帮我选\n', mockEnvironment(port))
    assert.equal(exitCode, 0, `没人回答也不能挂死,实际 ${exitCode},输出: ${output.slice(-400)}`)
    assert.ok(output.includes('按现有信息继续'), `模型应在无回答后继续,实际: ${output.slice(-400)}`)
    assert.ok(output.includes('用户无法回答提问'), '无用户可答时要记日志')
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
})

test('管道里的下一行在本轮结束后继续，而不是被丢掉', async () => {
  let requests = 0
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(
        'data: {"choices":[{"delta":{"content":"回复完毕"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    const { exitCode, output } = await runCliWithInput('第一句\n第二句\n', mockEnvironment(port))
    assert.equal(exitCode, 0, `应跑完两轮再退出,实际 ${exitCode},输出: ${output.slice(-400)}`)
    assert.equal(requests, 2, '第二行应再开一轮')
    assert.equal(output.split('回复完毕').length - 1, 2)
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
})

test('会话可以导出再导进另一个库', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grass-port-'))
  const mock = await startMockServer()
  try {
    const exported = await runCliWithInput('/export pack.json\n', {
      ...mockEnvironment(mock.port),
      GRASSAGENT_WORKSPACE: directory,
      GRASSAGENT_SESSION_DATABASE_PATH: path.join(directory, 'source.db'),
      GRASSAGENT_SESSION_ID: 'come-and-go',
      GRASSAGENT_LOAD_PROJECT_INSTRUCTIONS: '0',
    })
    assert.equal(exported.exitCode, 0, exported.output.slice(-400))
    assert.ok(exported.output.includes('已导出'), exported.output.slice(-400))
    const bundle = JSON.parse(await readFile(path.join(directory, 'pack.json'), 'utf8')) as {
      sessions: Array<{ id: string }>
    }
    assert.equal(bundle.sessions[0]?.id, 'come-and-go')

    const imported = await runCliWithInput('/import pack.json\n/sessions\n', {
      ...mockEnvironment(mock.port),
      GRASSAGENT_WORKSPACE: directory,
      GRASSAGENT_SESSION_DATABASE_PATH: path.join(directory, 'target.db'),
      GRASSAGENT_SESSION_ID: 'stay-here',
      GRASSAGENT_LOAD_PROJECT_INSTRUCTIONS: '0',
    })
    assert.equal(imported.exitCode, 0, imported.output.slice(-500))
    assert.ok(imported.output.includes('新增 1'), imported.output.slice(-500))
    assert.ok(imported.output.includes('come-and-go'), imported.output.slice(-500))
    assert.ok(!imported.output.includes('回复'), '导入导出不该发给模型')
  } finally {
    await mock.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('始终生效的项目规则会发给模型,提示词不会', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grass-rules-cli-'))
  await writeFile(path.join(directory, 'AGENTS.md'), 'UNIQUE_RULE 先写测试')
  await mkdir(path.join(directory, '.opencode', 'commands'), { recursive: true })
  await writeFile(path.join(directory, '.opencode', 'commands', 'test.md'), 'UNIQUE_PROMPT 跑全部测试')

  const requests: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
      response.end(
        'data: {"choices":[{"delta":{"content":"看过了"},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    const { exitCode, output } = await runCliWithInput('/instructions\n看一下\n', {
      ...mockEnvironment(port),
      GRASSAGENT_WORKSPACE: directory,
      GRASSAGENT_SESSION_DATABASE_PATH: path.join(directory, 'sessions.db'),
    })
    assert.equal(exitCode, 0, output.slice(-400))
    assert.ok(output.includes('AGENTS.md'), output.slice(-500))
    assert.ok(output.includes('/test'), output.slice(-500))
    assert.equal(requests.length, 1)
    const body = JSON.parse(requests[0] ?? '{}') as {
      messages: Array<{ role: string; content?: string }>
    }
    const system = body.messages.find((message) => message.role === 'system')?.content ?? ''
    assert.ok(system.includes('UNIQUE_RULE 先写测试'), '始终生效的规则要进系统提示词')
    assert.equal(system.includes('UNIQUE_PROMPT 跑全部测试'), false)
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    await rm(directory, { recursive: true, force: true })
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
