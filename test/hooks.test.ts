import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookRunner,
  parseHookOutput,
  type HookDefinition,
} from '../src/hooks.ts'

const runnerOptions = {
  sessionId: 'session-1',
  cwd: process.cwd(),
  defaultTimeoutMs: 2000,
}

function functionHook(
  event: HookDefinition['event'],
  handler: HookDefinition['handler'],
  extra: Partial<HookDefinition> = {},
): HookDefinition {
  return { event, handler, ...extra }
}

test('拒绝是粘性的,后面的允许不能翻回来', async () => {
  const runner = createHookRunner([
    functionHook('PreToolUse', () => ({ decision: 'block', reason: '第一条拒绝' })),
    functionHook('PreToolUse', () => ({ decision: 'approve', updatedInput: { value: 'later' } })),
  ], runnerOptions)

  const effect = await runner.run({ event: 'PreToolUse', toolName: 'write_file', toolInput: { value: 'a' } })
  assert.equal(effect.blocked, true)
  assert.equal(effect.reason, '第一条拒绝')
  assert.equal(effect.updatedInput, undefined)
})

test('前一个钩子改写的参数会传给后一个', async () => {
  const seen: unknown[] = []
  const runner = createHookRunner([
    functionHook('PreToolUse', () => ({ updatedInput: { value: 'b' } })),
    functionHook('PreToolUse', (input) => {
      seen.push(input.tool_input)
      return { updatedInput: { value: 'c' } }
    }),
  ], runnerOptions)

  const effect = await runner.run({ event: 'PreToolUse', toolName: 'edit', toolInput: { value: 'a' } })
  assert.equal(effect.blocked, false)
  assert.deepEqual(seen[0], { value: 'b' })
  assert.deepEqual(effect.updatedInput, { value: 'c' })
})

test('matcher 不中的钩子不跑', async () => {
  let called = false
  const runner = createHookRunner([
    functionHook('PreToolUse', () => {
      called = true
      return { decision: 'block', reason: '不该跑' }
    }, { matcher: /^write_file$/ }),
  ], runnerOptions)

  const effect = await runner.run({ event: 'PreToolUse', toolName: 'read_file', toolInput: {} })
  assert.equal(called, false)
  assert.equal(effect.blocked, false)
})

test('once 成功后不再跑,失败的下次还在', async () => {
  let runs = 0
  const runner = createHookRunner([
    functionHook('SessionStart', () => {
      runs += 1
      if (runs === 1) throw new Error('还没好')
      return { additionalContext: 'ready' }
    }, { once: true }),
  ], runnerOptions)

  const failed = await runner.run({ event: 'SessionStart' })
  assert.match(failed.errors[0] ?? '', /还没好/)
  const succeeded = await runner.run({ event: 'SessionStart' })
  assert.equal(succeeded.additionalContext, 'ready')
  await runner.run({ event: 'SessionStart' })
  assert.equal(runs, 2)
})

test('函数钩子抛错时放行,并带上错误', async () => {
  const runner = createHookRunner([
    functionHook('PreToolUse', () => {
      throw new Error('脚本坏了')
    }),
  ], runnerOptions)

  const effect = await runner.run({ event: 'PreToolUse', toolName: 'read_file', toolInput: {} })
  assert.equal(effect.blocked, false)
  assert.equal(effect.errors.length, 1)
  assert.match(effect.errors[0], /脚本坏了/)
})

test('permissionDecision=deny 视作拒绝', async () => {
  const runner = createHookRunner([
    functionHook('PreToolUse', () => ({
      permissionDecision: 'deny',
      permissionDecisionReason: '不许写',
    })),
  ], runnerOptions)

  const effect = await runner.run({ event: 'PreToolUse', toolName: 'write_file', toolInput: {} })
  assert.equal(effect.blocked, true)
  assert.equal(effect.reason, '不许写')
})

test('事件名对不上的 JSON 整份丢弃', () => {
  const parsed = parseHookOutput({
    decision: 'block',
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedInput: { value: 'x' } },
  }, 'PreToolUse')
  assert.ok('error' in parsed)
  assert.match(parsed.error, /事件名不匹配/)
})

test('命令钩子能读到 stdin 里的事件和会话', async () => {
  await withScript(`
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { raw += chunk })
    process.stdin.on('end', () => {
      const input = JSON.parse(raw)
      process.stdout.write(JSON.stringify({
        systemMessage: input.session_id,
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          additionalContext: input.tool_name,
          updatedInput: { command: 'ls' },
        },
      }))
    })
  `, async (command) => {
    const runner = createHookRunner([
      { event: 'PreToolUse', command, name: 'inspect' },
    ], runnerOptions)
    const effect = await runner.run({
      event: 'PreToolUse',
      toolName: 'run_bash',
      toolInput: { command: 'pwd' },
      toolUseId: 'call_1',
    })
    assert.equal(effect.blocked, false)
    assert.deepEqual(effect.systemMessages, ['session-1'])
    assert.equal(effect.additionalContext, 'run_bash')
    assert.deepEqual(effect.updatedInput, { command: 'ls' })
  })
})

test('不以花括号开头的 stdout 当成额外上下文', async () => {
  await withScript(`
    process.stdin.resume()
    process.stdout.write('记得先跑测试\\n')
  `, async (command) => {
    const runner = createHookRunner([
      { event: 'UserPromptSubmit', command },
    ], runnerOptions)
    const effect = await runner.run({ event: 'UserPromptSubmit', prompt: '你好' })
    assert.equal(effect.blocked, false)
    assert.equal(effect.additionalContext, '记得先跑测试')
  })
})

test('退出码 2 拒绝,退出码 1 只记失败', async () => {
  await withScript(`
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { raw += chunk })
    process.stdin.on('end', () => {
      const input = JSON.parse(raw)
      if (input.tool_name === 'run_bash') {
        process.stderr.write('不许跑命令')
        process.exit(2)
      }
      process.stderr.write('偶然失败')
      process.exit(1)
    })
  `, async (command) => {
    const runner = createHookRunner([
      { event: 'PreToolUse', command },
    ], runnerOptions)
    const blocked = await runner.run({ event: 'PreToolUse', toolName: 'run_bash', toolInput: {} })
    assert.equal(blocked.blocked, true)
    assert.match(blocked.reason ?? '', /不许跑命令/)

    const failed = await runner.run({ event: 'PreToolUse', toolName: 'read_file', toolInput: {} })
    assert.equal(failed.blocked, false)
    assert.match(failed.errors[0] ?? '', /退出码 1/)
    assert.match(failed.errors[0] ?? '', /偶然失败/)
  })
})

test('坏 JSON 放行', async () => {
  await withScript(`
    process.stdin.resume()
    process.stdout.write('{')
  `, async (command) => {
    const runner = createHookRunner([{ event: 'Stop', command }], runnerOptions)
    const effect = await runner.run({ event: 'Stop', prompt: 'done' })
    assert.equal(effect.blocked, false)
    assert.match(effect.errors[0] ?? '', /合法 JSON/)
  })
})

test('命令钩子超时后放行,进程不会留着', { timeout: 15_000 }, async () => {
  await withScript(`
    setInterval(() => {}, 1000)
  `, async (command) => {
    const runner = createHookRunner([
      { event: 'PreToolUse', command, timeoutMs: 200 },
    ], runnerOptions)
    const started = Date.now()
    const effect = await runner.run({ event: 'PreToolUse', toolName: 'read_file', toolInput: {} })
    assert.equal(effect.blocked, false)
    assert.match(effect.errors[0] ?? '', /超时/)
    assert.ok(Date.now() - started < 2000, '超时后应该很快返回')
  })
})

test('打断命令钩子时标记 aborted', { timeout: 15_000 }, async () => {
  await withScript(`
    setInterval(() => {}, 1000)
  `, async (command) => {
    const runner = createHookRunner([
      { event: 'PreToolUse', command, timeoutMs: 5000 },
    ], runnerOptions)
    const controller = new AbortController()
    const pending = runner.run({ event: 'PreToolUse', toolName: 'read_file', toolInput: {} }, controller.signal)
    setTimeout(() => controller.abort(), 50)
    const effect = await pending
    assert.equal(effect.aborted, true)
    assert.equal(effect.blocked, false)
  })
})

async function withScript(source: string, run: (command: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'grass-hook-'))
  const scriptPath = join(directory, 'hook.mjs')
  await writeFile(scriptPath, source)
  try {
    await run(shellCommand(scriptPath))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function shellCommand(scriptPath: string): string {
  return `${quoteShell(process.execPath)} ${quoteShell(scriptPath)}`
}

function quoteShell(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}
