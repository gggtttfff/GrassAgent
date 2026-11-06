import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionStore, generateSessionId } from '../src/sessionStore.ts'
import type { Message } from '../src/messages.ts'

// 每次用例用独立的库文件,避免互相干扰
function createDatabasePath(): string {
  const directory = path.join(
    os.tmpdir(),
    `grassagent-sqlite-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  return path.join(directory, 'sessions.db')
}

function userMessage(text: string): Message {
  return { role: 'user', content: text }
}

test('sync 写入的消息能读回来', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    store.sync([userMessage('你好'), { role: 'assistant', content: '世界' }])
    const loaded = store.load()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0].content, '你好')
    assert.equal(loaded[1].role, 'assistant')
  } finally {
    store.close()
  }
})

test('sync 只写新增部分', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    const messages = [userMessage('第一条'), userMessage('第二条')]
    assert.equal(store.sync(messages), 2)
    // 再传同样的数组不该重复写
    assert.equal(store.sync(messages), 0)
    assert.equal(store.load().length, 2)
  } finally {
    store.close()
  }
})

test('sync 传完整列表时只追加新增的那条', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    const messages: Message[] = [userMessage('第一条')]
    store.sync(messages)

    messages.push(userMessage('第二条'))
    assert.equal(store.sync(messages), 1)
    assert.equal(store.load().length, 2)
  } finally {
    store.close()
  }
})

test('不同 sessionId 的会话互相隔离', () => {
  const databasePath = createDatabasePath()
  const first = new SessionStore({ databasePath, sessionId: 'session-a' })
  const second = new SessionStore({ databasePath, sessionId: 'session-b' })
  try {
    first.sync([userMessage('A 的消息')])
    second.sync([userMessage('B 的消息'), userMessage('B 的第二条')])

    assert.equal(first.load().length, 1)
    assert.equal(first.load()[0].content, 'A 的消息')
    assert.equal(second.load().length, 2)
    assert.equal(second.load()[0].content, 'B 的消息')
  } finally {
    first.close()
    second.close()
  }
})

test('重新打开数据库能读回之前写的消息', () => {
  const databasePath = createDatabasePath()
  const first = new SessionStore({ databasePath, sessionId: 's1' })
  first.sync([userMessage('持久化的消息')])
  first.close()

  const second = new SessionStore({ databasePath, sessionId: 's1' })
  try {
    const loaded = second.load()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].content, '持久化的消息')
  } finally {
    second.close()
  }
})

test('数据库目录不存在时自动创建', () => {
  const directory = path.join(
    os.tmpdir(),
    `grassagent-sqlite-mkdir-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  const databasePath = path.join(directory, 'nested', 'sessions.db')
  const store = new SessionStore({ databasePath, sessionId: 's1' })
  try {
    store.sync([userMessage('x')])
    assert.ok(store.load().length === 1)
  } finally {
    store.close()
  }
})

test('listSessions 列出所有会话', () => {
  const databasePath = createDatabasePath()
  const first = new SessionStore({ databasePath, sessionId: 'session-a' })
  const second = new SessionStore({ databasePath, sessionId: 'session-b' })
  try {
    const sessions = first.listSessions()
    assert.ok(sessions.includes('session-a'))
    assert.ok(sessions.includes('session-b'))
  } finally {
    first.close()
    second.close()
  }
})

test('关闭后写入会报错', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  store.close()
  assert.throws(() => store.sync([userMessage('x')]), /已关闭/)
})

test('重复 close 不报错', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  store.close()
  store.close()
})

test('空库 load 返回空数组', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    assert.deepEqual(store.load(), [])
  } finally {
    store.close()
  }
})

test('generateSessionId 不重复', () => {
  const ids = new Set<string>()
  for (let index = 0; index < 100; index++) {
    ids.add(generateSessionId())
  }
  assert.equal(ids.size, 100, '每次生成都应唯一')
})

test('多进程共享同一个数据库文件', async () => {
  const databasePath = createDatabasePath()
  const directory = path.dirname(databasePath)
  await fs.mkdir(directory, { recursive: true })

  // 模拟两个进程:各自打开同一个库,写不同的会话
  const first = new SessionStore({ databasePath, sessionId: 'proc-1' })
  const second = new SessionStore({ databasePath, sessionId: 'proc-2' })
  try {
    first.sync([userMessage('进程1的消息')])
    second.sync([userMessage('进程2的消息')])

    // 各自的会话互不干扰
    assert.equal(first.load()[0].content, '进程1的消息')
    assert.equal(second.load()[0].content, '进程2的消息')

    // 第三个实例能看到前两个的会话
    const third = new SessionStore({ databasePath, sessionId: 'proc-3' })
    try {
      const sessions = third.listSessions()
      assert.ok(sessions.includes('proc-1'))
      assert.ok(sessions.includes('proc-2'))
      assert.ok(sessions.includes('proc-3'))
    } finally {
      third.close()
    }
  } finally {
    first.close()
    second.close()
  }
})

test('消息内容里的换行和特殊字符能正确存储', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    const tricky = '包含\n换行、\t制表符、"引号"和\\反斜杠'
    store.sync([userMessage(tricky)])
    assert.equal(store.load()[0].content, tricky)
  } finally {
    store.close()
  }
})

test('工具调用消息能完整存储', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    store.sync([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来读文件' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '文件内容' }],
      },
    ])

    const loaded = store.load()
    assert.equal(loaded.length, 2)
    const blocks = loaded[0].content as Array<{ type: string }>
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[1].type, 'tool_use')
    const resultBlocks = loaded[1].content as Array<{ type: string }>
    assert.equal(resultBlocks[0].type, 'tool_result')
  } finally {
    store.close()
  }
})
