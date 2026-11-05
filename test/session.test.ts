import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionStore, SessionLockError } from '../src/session.ts'
import type { Message } from '../src/messages.ts'

// 每个用例用独立的工作目录,避免互相干扰
let workDirectory = ''

function createWorkDirectory(): string {
  workDirectory = path.join(os.tmpdir(), `grassagent-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  return workDirectory
}

function sessionFilePath(): string {
  return path.join(createWorkDirectory(), 'session.jsonl')
}

function userMessage(text: string): Message {
  return { role: 'user', content: text }
}

test('打开会话存储会创建锁文件', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath })
  try {
    const stats = await fs.stat(`${filePath}.lock`)
    assert.ok(stats.isFile(), '锁文件应当存在')
  } finally {
    await store.release()
  }
})

test('release 后锁文件被删除', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath })
  await store.release()
  await assert.rejects(fs.stat(`${filePath}.lock`), '锁文件应当已删除')
})

test('第二个实例拿不到锁时抛 SessionLockError', async () => {
  const filePath = sessionFilePath()
  const first = await SessionStore.open({ filePath })
  try {
    await assert.rejects(
      SessionStore.open({ filePath, lockTimeoutMs: 200 }),
      SessionLockError,
    )
  } finally {
    await first.release()
  }
})

test('锁错误信息里带有持锁进程 pid', async () => {
  const filePath = sessionFilePath()
  const first = await SessionStore.open({ filePath })
  try {
    await assert.rejects(
      SessionStore.open({ filePath, lockTimeoutMs: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof SessionLockError)
        assert.equal(error.holderPid, process.pid)
        assert.ok(error.message.includes(String(process.pid)))
        return true
      },
    )
  } finally {
    await first.release()
  }
})

test('持锁进程退出后残留锁可以被接管', async () => {
  const filePath = sessionFilePath()
  const first = await SessionStore.open({ filePath })
  // 模拟进程被杀:锁文件留下,但 pid 指向不存在的进程
  await fs.writeFile(`${filePath}.lock`, JSON.stringify({ pid: 999999999, acquiredAt: Date.now() }), 'utf-8')
  await first.release()

  const second = await SessionStore.open({ filePath, lockTimeoutMs: 1000 })
  await second.release()
})

test('锁超时时间到之前一直重试', async () => {
  const filePath = sessionFilePath()
  const first = await SessionStore.open({ filePath })
  try {
    const startedAt = Date.now()
    await assert.rejects(SessionStore.open({ filePath, lockTimeoutMs: 600 }))
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 500, `应至少等待 500ms,实际 ${elapsed}ms`)
  } finally {
    await first.release()
  }
})

test('sync 只写新增消息', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath })
  try {
    const messages = [userMessage('第一条'), userMessage('第二条')]
    const written = await store.sync(messages)
    assert.equal(written, 2)

    // 再传同样的数组,不该重复写
    const again = await store.sync(messages)
    assert.equal(again, 0)

    const content = await fs.readFile(filePath, 'utf-8')
    assert.equal(content.trim().split('\n').length, 2)
  } finally {
    await store.release()
  }
})

test('sync 传完整列表时只追加新增的那条', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath })
  try {
    const messages: Message[] = [userMessage('第一条')]
    await store.sync(messages)

    messages.push(userMessage('第二条'))
    const written = await store.sync(messages)
    assert.equal(written, 1)

    const content = await fs.readFile(filePath, 'utf-8')
    assert.equal(content.trim().split('\n').length, 2)
  } finally {
    await store.release()
  }
})

test('load 能读回写入的消息', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath })
  try {
    await store.sync([userMessage('你好'), { role: 'assistant', content: '世界' }])
    const loaded = await store.load()
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0].content, '你好')
    assert.equal(loaded[1].role, 'assistant')
  } finally {
    await store.release()
  }
})

test('load 跳过损坏的行而不是丢弃整个文件', async () => {
  const filePath = sessionFilePath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(
    filePath,
    [
      JSON.stringify(userMessage('第一条')),
      '{坏掉的JSON',
      JSON.stringify(userMessage('第三条')),
    ].join('\n'),
    'utf-8',
  )

  const store = await SessionStore.open({ filePath })
  try {
    const loaded = await store.load()
    assert.equal(loaded.length, 2, '坏行应被跳过,好行应保留')
    assert.equal(loaded[0].content, '第一条')
    assert.equal(loaded[1].content, '第三条')
  } finally {
    await store.release()
  }
})

test('超过阈值时轮转,旧内容进备份文件', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath, maxFileBytes: 1024, maxBackupFiles: 3 })
  try {
    // 持续追加足够多的内容触发轮转
    const messages: Message[] = []
    for (let index = 0; index < 20; index++) {
      messages.push(userMessage(`消息${index}${'x'.repeat(100)}`))
      await store.sync(messages)
    }

    const backupPath = filePath.replace('.jsonl', '.1.jsonl')
    const backupExists = await fs.access(backupPath).then(() => true, () => false)
    assert.ok(backupExists, '备份文件应当存在')

    // 备份 + 当前文件的内容合起来要包含所有消息
    const loaded = await store.load()
    assert.ok(loaded.length >= 20, `应保留全部消息,实际 ${loaded.length}`)
  } finally {
    await store.release()
  }
})

test('轮转后 load 按时间顺序拼接备份和当前文件', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath, maxFileBytes: 1024, maxBackupFiles: 3 })
  try {
    const messages: Message[] = [userMessage('第一条')]
    await store.sync(messages)
    // 触发轮转
    for (let index = 0; index < 20; index++) {
      messages.push(userMessage(`消息${index}${'y'.repeat(100)}`))
      await store.sync(messages)
    }
    messages.push(userMessage('最后一条'))
    await store.sync(messages)

    const loaded = await store.load()
    assert.equal(loaded[0].content, '第一条', '最早的消息应在最前')
    assert.equal(loaded[loaded.length - 1].content, '最后一条', '最新的消息应在最后')
  } finally {
    await store.release()
  }
})

test('备份文件数量不超过上限', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath, maxFileBytes: 512, maxBackupFiles: 2 })
  try {
    const messages: Message[] = []
    for (let index = 0; index < 50; index++) {
      messages.push(userMessage(`消息${index}${'z'.repeat(100)}`))
      await store.sync(messages)
    }

    const directory = path.dirname(filePath)
    const files = await fs.readdir(directory)
    const backups = files.filter((name) => /^session\.\d+\.jsonl$/.test(name))
    assert.ok(backups.length <= 2, `备份不应超过 2 个,实际 ${backups.length}`)
  } finally {
    await store.release()
  }
})

test('轮转失败不影响主文件写入', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath, maxFileBytes: 100 })
  try {
    const messages: Message[] = [userMessage('第一条')]
    await store.sync(messages)
    // 触发轮转,即使轮转出问题也要能继续写
    messages.push(userMessage('第二条'.padEnd(200, 'w')))
    await store.sync(messages)

    const content = await fs.readFile(filePath, 'utf-8')
    assert.ok(content.includes('第二条'), '主文件应仍能写入')
  } finally {
    await store.release()
  }
})

test('文件不存在时 load 返回空数组', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath })
  try {
    assert.deepEqual(await store.load(), [])
  } finally {
    await store.release()
  }
})

test('release 之后再 release 不会报错', async () => {
  const filePath = sessionFilePath()
  const store = await SessionStore.open({ filePath })
  await store.release()
  await store.release()
})
