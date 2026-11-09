import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookConfigError, defaultHooksFilePath, loadHooksFile } from '../src/hookConfig.ts'

test('默认路径落在工作区的 .grass 目录', () => {
  assert.equal(defaultHooksFilePath('/work'), join('/work', '.grass', 'hooks.json'))
})

test('可选文件不存在时没有钩子', async () => {
  const missing = join(tmpdir(), `grass-hooks-missing-${process.pid}.json`)
  const definitions = await loadHooksFile(missing, { optional: true })
  assert.deepEqual(definitions, [])
})

test('显式路径不存在时报错', async () => {
  const missing = join(tmpdir(), `grass-hooks-required-${process.pid}.json`)
  await assert.rejects(loadHooksFile(missing, { optional: false }), HookConfigError)
})

test('能读出命令、matcher 和超时', async () => {
  await withFile({
    PreToolUse: [
      {
        matcher: '^run_bash$',
        hooks: [{ type: 'command', command: 'node guard.mjs', timeoutMs: 1500, once: true }],
      },
    ],
  }, async (filePath) => {
    const definitions = await loadHooksFile(filePath, { optional: false })
    assert.equal(definitions.length, 1)
    assert.equal(definitions[0].event, 'PreToolUse')
    assert.equal(definitions[0].command, 'node guard.mjs')
    assert.equal(definitions[0].timeoutMs, 1500)
    assert.equal(definitions[0].once, true)
    assert.equal(definitions[0].matcher?.test('run_bash'), true)
    assert.equal(definitions[0].matcher?.test('read_file'), false)
  })
})

test('包一层 hooks 也能读', async () => {
  await withFile({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node stop.mjs' }] }],
    },
  }, async (filePath) => {
    const definitions = await loadHooksFile(filePath, { optional: false })
    assert.equal(definitions.length, 1)
    assert.equal(definitions[0].event, 'Stop')
  })
})

test('未知事件名会被拒绝', async () => {
  await withFile({
    NotAnEvent: [{ hooks: [{ type: 'command', command: 'node x.mjs' }] }],
  }, async (filePath) => {
    await assert.rejects(loadHooksFile(filePath, { optional: false }), HookConfigError)
  })
})

test('非法 matcher 在加载时失败', async () => {
  await withFile({
    PreToolUse: [{ matcher: '(', hooks: [{ type: 'command', command: 'node x.mjs' }] }],
  }, async (filePath) => {
    await assert.rejects(
      loadHooksFile(filePath, { optional: false }),
      (error: unknown) => {
        assert.ok(error instanceof HookConfigError)
        assert.match(error.message, /matcher/)
        return true
      },
    )
  })
})

test('不支持的钩子类型会被拒绝', async () => {
  await withFile({
    PreToolUse: [{ hooks: [{ type: 'http', url: 'https://example.com' }] }],
  }, async (filePath) => {
    await assert.rejects(loadHooksFile(filePath, { optional: false }), HookConfigError)
  })
})

test('嵌套过深的钩子文件在解析前拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grass-hook-config-'))
  const filePath = join(directory, 'hooks.json')
  await writeFile(filePath, '['.repeat(400) + ']'.repeat(400))
  try {
    await assert.rejects(loadHooksFile(filePath, { optional: false }), (error: unknown) => {
      assert.ok(error instanceof HookConfigError)
      assert.match((error as Error).message, /嵌套/)
      return true
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('async 字段会被拒绝', async () => {
  await withFile({
    SessionStart: [{ hooks: [{ type: 'command', command: 'node x.mjs', async: true }] }],
  }, async (filePath) => {
    await assert.rejects(loadHooksFile(filePath, { optional: false }), HookConfigError)
  })
})

async function withFile(value: unknown, run: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'grass-hook-config-'))
  const filePath = join(directory, 'hooks.json')
  await writeFile(filePath, JSON.stringify(value))
  try {
    await run(filePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
