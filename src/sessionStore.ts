// src/sessionStore.ts
// 会话存储 —— 基于 Node 内置的 node:sqlite,零运行时依赖。
//
// 为什么换 SQLite:
// - 追加式 JSONL 无限增长,只能靠轮转处理,查询历史也要自己解析整个文件
// - SQLite 自带事务、索引和并发控制,不用自己维护锁文件
// - node:sqlite 是 Node 内置能力,符合"核心逻辑不引运行时依赖"的约束
//
// 并发模型:
// WAL 模式 + busy_timeout,多个进程可以同时读写同一个数据库文件。
// 每个进程用独立的 sessionId,各存各的会话,互不干扰。
// 这比之前的锁文件方案好:锁文件只能"拒绝第二个实例",现在允许多实例并行。
//
// 注意:node:sqlite 目前是实验性 API,会打印 ExperimentalWarning。
// 这里做了定向抑制,只压 SQLite 那一条,不影响其他警告。

import { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'
import { mkdirSync } from 'node:fs'
import { normalizeMessage, type Message } from './messages.ts'

// 抑制 node:sqlite 的实验性警告,详见下方函数的说明。
suppressSqliteWarning()

// 抑制 node:sqlite 的实验性警告。
//
// node:sqlite 目前是实验性 API,首次导入时会打印 ExperimentalWarning。
// 启动脚本已经加了 --disable-warning=ExperimentalWarning,这里是兜底——
// 用户直接跑 `node src/cli.ts` 时也能干净。
//
// 实现要点:必须拦 process.emit,不能只拦 process.emitWarning。
// Node 内部派发警告走的是 process.emit('warning', ...),
// 只拦 emitWarning 不起作用(实测过)。
function suppressSqliteWarning(): void {
  const originalEmit = process.emit
  process.emit = function patchedEmit(
    eventName: string | symbol,
    ...arguments_: unknown[]
  ): boolean {
    if (eventName === 'warning') {
      const warning = arguments_[0] as { name?: string; message?: string } | undefined
      if (warning?.name === 'ExperimentalWarning' && warning.message?.includes('SQLite')) {
        // 吞掉这一条,其余警告照常输出
        return false
      }
    }
    return originalEmit.apply(process, [eventName, ...arguments_] as Parameters<typeof originalEmit>)
  } as typeof process.emit
}

/** 会话存储的选项 */
export interface SessionStoreOptions {
  /** 数据库文件路径。':memory:' 表示内存库(测试用) */
  databasePath: string
  /** 会话 ID。同一个库里的不同 ID 是互相隔离的会话 */
  sessionId: string
  /** 锁等待毫秒。多个进程同时写时,写锁最多等这么久 */
  busyTimeoutMs?: number
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000

// 建表语句。
// 用 IF NOT EXISTS,重复打开不会报错。
// messages 表用 (session_id, seq) 唯一约束,保证同一会话内序号不重复。
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, seq)`,
]

/**
 * SQLite 会话存储。
 *
 * 用法:
 *   const store = new SessionStore({ databasePath, sessionId })
 *   const messages = store.load()
 *   store.sync(messages)
 *   store.close()
 */
export class SessionStore {
  readonly databasePath: string
  readonly sessionId: string

  private readonly database: DatabaseSync
  // 已持久化的消息数。sync 只写 seq 大于这个值的,避免重复写。
  private persistedCount = 0
  private closed = false

  constructor(options: SessionStoreOptions) {
    this.databasePath =
      options.databasePath === ':memory:' ? ':memory:' : path.resolve(options.databasePath)
    this.sessionId = options.sessionId

    // 内存库不能设 WAL,会报错
    if (this.databasePath !== ':memory:') {
      // 同步建目录:构造函数是同步的,异步 mkdir 还没完成数据库就已经打开了。
      // 递归建,已存在时不会报错。
      try {
        mkdirSync(path.dirname(this.databasePath), { recursive: true })
      } catch {
        // 建不了目录就往下走,DatabaseSync 打开时会报更具体的错
      }
    }

    this.database = new DatabaseSync(this.databasePath)

    if (this.databasePath !== ':memory:') {
      // WAL 模式:读写不互相阻塞,多进程能并行
      this.database.exec('PRAGMA journal_mode = WAL')
    }
    // 写锁最多等这么久,避免立刻抛 SQLITE_BUSY
    this.database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`)
    // 同步级别:NORMAL 在 WAL 下够用,且比 FULL 快很多
    this.database.exec('PRAGMA synchronous = NORMAL')

    for (const statement of SCHEMA_STATEMENTS) {
      this.database.exec(statement)
    }

    this.ensureSessionRow()
  }

  /**
   * 读取当前会话的历史消息,按 seq 升序。
   */
  load(): Message[] {
    const rows = this.database
      .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(this.sessionId) as Array<{ content: string }>

    const messages: Message[] = []
    for (const row of rows) {
      try {
        const normalized = normalizeMessage(JSON.parse(row.content) as unknown)
        if (normalized) messages.push(normalized)
      } catch {
        // 坏行跳过,不丢整个会话
      }
    }

    this.persistedCount = messages.length
    return messages
  }

  /**
   * 把完整会话同步到存储。只写 persistedCount 之后的新增部分。
   *
   * 注意:参数是**完整的会话消息列表**,不是增量。
   * 传增量会写不进去(切片后为空)。
   */
  sync(messages: Message[]): number {
    if (this.closed) throw new Error('会话存储已关闭')
    const newMessages = messages.slice(this.persistedCount)
    if (newMessages.length === 0) return 0

    const insert = this.database.prepare(
      'INSERT INTO messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    const touch = this.database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')

    const now = Date.now()
    // 一个事务写完,要么全成功要么全回滚——
    // 中途失败不会留下半截消息,破坏消息配对关系
    this.database.exec('BEGIN')
    try {
      let seq = this.persistedCount
      for (const message of newMessages) {
        insert.run(
          this.sessionId,
          seq,
          message.role,
          JSON.stringify(message),
          now,
        )
        seq++
      }
      touch.run(now, this.sessionId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }

    this.persistedCount = messages.length
    return newMessages.length
  }

  /** 关闭数据库。进程退出前调用,确保数据落盘 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  // 确保 sessions 表里有当前会话的行,方便外部工具查看有哪些会话
  private ensureSessionRow(): void {
    const now = Date.now()
    this.database
      .prepare(
        'INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at',
      )
      .run(this.sessionId, now, now)
  }

  /** 列出数据库里所有会话的 ID,按更新时间倒序 */
  listSessions(): string[] {
    const rows = this.database
      .prepare('SELECT id FROM sessions ORDER BY updated_at DESC')
      .all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  }
}

/**
 * 生成会话 ID。
 * 格式:时间戳 + 随机后缀,保证同一毫秒内启动的多个进程也不会撞。
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${timestamp}-${random}`
}
