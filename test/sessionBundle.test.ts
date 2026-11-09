import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionStore } from '../src/sessionStore.ts'
import type { Message } from '../src/messages.ts'
import {
  BUNDLE_FORMAT,
  BundleError,
  defaultBundlePath,
  parseBundle,
  parseExportArgument,
  parseImportArgument,
  readBundleFile,
  resolveBundlePath,
  serializeBundle,
  writeBundleFile,
} from '../src/sessionBundle.ts'

function userMessage(text: string): Message {
  return { role: 'user', content: text }
}

test('导出会话再读回来,内容不变', async () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 'trip' })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-bundle-'))
  try {
    store.sync([
      userMessage('带上我'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '文件' }],
      },
    ])
    const snapshots = store.listSnapshots()
    const filePath = path.join(directory, 'pack.json')
    await writeBundleFile(filePath, snapshots)
    const loaded = await readBundleFile(filePath)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, 'trip')
    assert.deepEqual(loaded[0].messages, snapshots[0].messages)

    const fresh = new SessionStore({ databasePath: ':memory:', sessionId: 'here' })
    try {
      assert.equal(fresh.importSession(loaded[0], 'merge'), 'imported')
      assert.equal(fresh.readSession('trip')?.messages[0].content, '带上我')
    } finally {
      fresh.close()
    }
  } finally {
    store.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('会话包里没有密钥字段', () => {
  const text = serializeBundle([{
    id: 's1',
    createdAt: 1,
    updatedAt: 2,
    messages: [userMessage('你好')],
  }], '2026-01-01T00:00:00.000Z')
  const parsed = JSON.parse(text) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed).sort(), ['exportedAt', 'format', 'sessions', 'version'])
  assert.equal(parsed.format, BUNDLE_FORMAT)
  assert.equal(text.includes('apiKey'), false)
  assert.equal(text.includes('GRASSAGENT_API_KEY'), false)
})

test('不是会话包、版本不对、工具调用配不上对,都拒绝', () => {
  assert.throws(() => parseBundle('{"format":"other","version":1,"sessions":[]}'), BundleError)
  assert.throws(() => parseBundle(JSON.stringify({
    format: BUNDLE_FORMAT,
    version: 2,
    sessions: [],
  })), /不支持的会话包版本/)
  assert.throws(() => parseBundle(JSON.stringify({
    format: BUNDLE_FORMAT,
    version: 1,
    sessions: [{
      id: 'broken',
      createdAt: 1,
      updatedAt: 2,
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }],
      }],
    }],
  })), /配不上对/)
})

test('会话 ID 重复或带路径分隔符时拒绝', () => {
  const session = {
    id: 'ok',
    createdAt: 1,
    updatedAt: 2,
    messages: [userMessage('a')],
  }
  assert.throws(() => parseBundle(JSON.stringify({
    format: BUNDLE_FORMAT,
    version: 1,
    sessions: [session, { ...session }],
  })), /重复/)
  assert.throws(() => parseBundle(JSON.stringify({
    format: BUNDLE_FORMAT,
    version: 1,
    sessions: [{ ...session, id: '../etc/passwd' }],
  })), /会话 ID/)
})

test('导出和导入的参数', () => {
  assert.deepEqual(parseExportArgument(''), {})
  assert.deepEqual(parseExportArgument('out.json'), { filePath: 'out.json' })
  assert.deepEqual(parseExportArgument('out.json --session abc'), { filePath: 'out.json', sessionId: 'abc' })
  assert.equal(parseExportArgument('--session')?.error?.includes('会话 ID'), true)
  assert.deepEqual(parseImportArgument('in.json'), { filePath: 'in.json', replace: false })
  assert.deepEqual(parseImportArgument('in.json --replace'), { filePath: 'in.json', replace: true })
  assert.equal(parseImportArgument('')?.error?.includes('路径'), true)
})

test('相对路径锚定工作区,~ 展开到主目录', () => {
  const workspace = path.join(os.tmpdir(), 'grass-work')
  assert.equal(resolveBundlePath('pack.json', workspace), path.join(workspace, 'pack.json'))
  assert.equal(resolveBundlePath('~/pack.json', workspace), path.join(os.homedir(), 'pack.json'))
  assert.equal(defaultBundlePath(workspace), path.join(workspace, '.grass', 'grassagent-bundle.json'))
})

test('嵌套过深的会话包在解析前拒绝,深对象也不会拿去序列化', () => {
  const hostile = `{"format":"${BUNDLE_FORMAT}","version":1,"exportedAt":"2025-07-18T00:00:00.000Z","sessions":${'['.repeat(300)}${']'.repeat(300)}}`
  assert.throws(() => parseBundle(hostile), (error: unknown) => {
    assert.ok(error instanceof BundleError)
    assert.match((error as Error).message, /嵌套/)
    return true
  })

  let input: unknown = { ok: true }
  for (let index = 0; index < 300; index++) input = { nested: input }
  assert.throws(() => serializeBundle([{
    id: 'deep',
    createdAt: 1,
    updatedAt: 2,
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input }],
    }],
  }]), (error: unknown) => {
    assert.ok(error instanceof BundleError)
    assert.match((error as Error).message, /拒绝序列化/)
    return true
  })
})
