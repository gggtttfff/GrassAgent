import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
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

test('listSessionDetails 带出消息条数', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    store.sync([userMessage('一'), { role: 'assistant', content: '二' }])
    const details = store.listSessionDetails()
    assert.equal(details.length, 1)
    assert.equal(details[0].id, 's1')
    assert.equal(details[0].messageCount, 2)
    assert.ok(details[0].updatedAt > 0)
  } finally {
    store.close()
  }
})

test('历史被替换后能重新写入', () => {
  // /clear 会把历史清空。清空之后新说的话必须能存进去——
  // 按「新增条数」切片的话,历史变短了切片就是空的,消息会静默丢掉。
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    store.sync([userMessage('清空前'), { role: 'assistant', content: '清空前' }])
    assert.equal(store.load().length, 2)

    // 历史被清空
    const cleared: Message[] = []
    store.sync(cleared)

    // 清空后新说的话
    const written = store.sync([userMessage('清空后')])
    assert.equal(written, 1, '清空后的新消息应该写进去')

    const loaded = store.load()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].content, '清空后')
  } finally {
    store.close()
  }
})

test('历史内容被换掉时能重新写入', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    store.sync([userMessage('第一条'), userMessage('第二条')])

    // 内容变了但条数没变——按条数切片看不出来,但内容确实换了
    const replaced: Message[] = [userMessage('换了'), userMessage('也换了')]
    store.sync(replaced)

    const loaded = store.load()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0].content, '换了')
    assert.equal(loaded[1].content, '也换了')
  } finally {
    store.close()
  }
})

test('createSession 开新会话,旧会话保留', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 'session-a' })
  try {
    const oldMessages = [userMessage('A 的消息')]
    store.sync(oldMessages)

    const newSessionId = store.createSession(oldMessages)
    assert.notEqual(newSessionId, 'session-a')
    assert.equal(store.sessionId, newSessionId)

    // 新会话是空的
    assert.equal(store.load().length, 0)

    // 旧会话还在库里
    store.switchSession('session-a', [])
    assert.equal(store.load()[0].content, 'A 的消息')
  } finally {
    store.close()
  }
})

test('switchSession 切换后各自的史独立', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 'session-a' })
  try {
    const messagesA = [userMessage('A1'), userMessage('A2')]
    store.sync(messagesA)

    const newSessionId = store.createSession(messagesA)
    const messagesB = [userMessage('B1')]
    store.sync(messagesB)

    // 切回 A,历史还在
    store.switchSession('session-a', messagesB)
    assert.deepEqual(store.load().map((message) => message.content), ['A1', 'A2'])

    // A 里追加一条,应该写进 A
    const messagesA2 = [...messagesA, userMessage('A3')]
    store.sync(messagesA2)
    assert.equal(store.load().length, 3)

    // 切回 B,B 里还是只有一条
    store.switchSession(newSessionId, messagesA2)
    assert.deepEqual(store.load().map((message) => message.content), ['B1'])
  } finally {
    store.close()
  }
})

test('switchSession 切到当前会话不做任何事', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    const messages = [userMessage('x')]
    store.sync(messages)
    store.switchSession('s1', messages)
    assert.equal(store.sessionId, 's1')
    assert.equal(store.load().length, 1)
  } finally {
    store.close()
  }
})

test('关闭后切换会话会报错', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  store.close()
  assert.throws(() => store.switchSession('s2', []), /已关闭/)
  assert.throws(() => store.createSession([]), /已关闭/)
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

test('标题能写进当前会话,列表里也能看到', () => {
  const store = new SessionStore({ databasePath: ':memory:', sessionId: 's1' })
  try {
    assert.equal(store.getTitle(), null)
    store.setTitle('  修登录  ')
    assert.equal(store.getTitle(), '修登录')
    assert.equal(store.listSessionDetails()[0].title, '修登录')
    store.setTitle('   ')
    assert.equal(store.getTitle(), '修登录', '空标题不该把已有标题擦掉')
  } finally {
    store.close()
  }
})

test('没有 title 列的旧库打开后能补上', () => {
  const databasePath = createDatabasePath()
  mkdirSync(path.dirname(databasePath), { recursive: true })
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(
    'CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  )
  legacy.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)').run('old', 1, 1)
  legacy.close()

  const store = new SessionStore({ databasePath, sessionId: 'old' })
  try {
    store.setTitle('旧库标题')
    assert.equal(store.getTitle(), '旧库标题')
  } finally {
    store.close()
  }
})
