// src/sessionStore.ts
// 会话存储 —— 基于 Node 内置的 node:sqlite,零运行时依赖。
//
// 为什么用 SQLite:
// - 追加式 JSONL 无限增长,只能靠轮转处理,查询历史也要自己解析整个文件
// - SQLite 自带事务、索引和并发控制,不用自己维护锁文件
// - node:sqlite 是 Node 内置能力,符合"核心逻辑不引运行时依赖"的约束
//
// 并发模型:
// WAL 模式 + busy_timeout,多个进程可以同时读写同一个数据库文件。
// 每个进程用独立的 sessionId,各存各的会话,互不干扰——
// 多实例并行是允许的,不像锁文件方案那样只能有一个进程。
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
     updated_at INTEGER NOT NULL,
     title TEXT
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

  private readonly database: DatabaseSync
  private currentSessionId: string
  // 已持久化的消息数。sync 只写 seq 大于这个值的,避免重复写。
  private persistedCount = 0
  // 已持久化的消息内容(序列化后的 JSON)。
  // 用来判断历史是不是被替换过——/clear 和切换会话都会换掉内容。
  private persistedContents: string[] = []
  private closed = false

  constructor(options: SessionStoreOptions) {
    this.databasePath =
      options.databasePath === ':memory:' ? ':memory:' : path.resolve(options.databasePath)
    this.currentSessionId = options.sessionId

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
    // 旧库的 sessions 表没有 title。IF NOT EXISTS 不会补列,这里单独加上。
    this.ensureTitleColumn()

    this.ensureSessionRow()
  }

  /** 当前会话的标题。还没生成过就是 null */
  getTitle(): string | null {
    const rows = this.database
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .all(this.currentSessionId) as Array<{ title: string | null }>
    const title = rows[0]?.title?.trim()
    return title ? title : null
  }

  /** 写下小模型生成的标题。空字符串忽略,避免把已有标题擦掉 */
  setTitle(title: string): void {
    if (this.closed) throw new Error('会话存储已关闭')
    const trimmed = title.trim()
    if (!trimmed) return
    this.database
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(trimmed, Date.now(), this.currentSessionId)
  }

  /** 当前会话的 ID */
  get sessionId(): string {
    return this.currentSessionId
  }

  /**
   * 读取当前会话的历史消息,按 seq 升序。
   */
  load(): Message[] {
    const rows = this.database
      .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(this.currentSessionId) as Array<{ content: string }>

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
    this.persistedContents = messages.map((message) => JSON.stringify(message))
    return messages
  }

  /**
   * 把完整会话同步到存储。
   *
   * 正常情况只写 persistedCount 之后的新增部分。
   *
   * 但历史有可能被整体替换——/clear 清空对话、切换会话换掉内容。
   * 这时按「新增条数」切片就会算错:历史变短了,切片切到空,
   * 之后新说的话一条也写不进去。
   *
   * 所以先对一下账:传进来的列表如果跟已存的内容对不上,
   * 就当成「历史被替换」,把旧的删掉重写一遍。
   *
   * 注意:参数是**完整的会话消息列表**,不是增量。
   * 传增量会写不进去(切片后为空)。
   */
  sync(messages: Message[]): number {
    if (this.closed) throw new Error('会话存储已关闭')

    // 历史被替换过:删掉旧内容,从头重写
    if (this.historyReplaced(messages)) {
      return this.rewrite(messages)
    }

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
          this.currentSessionId,
          seq,
          message.role,
          JSON.stringify(message),
          now,
        )
        seq++
      }
      touch.run(now, this.currentSessionId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }

    this.persistedCount = messages.length
    for (const message of newMessages) {
      this.persistedContents.push(JSON.stringify(message))
    }
    return newMessages.length
  }

  /**
   * 判断传进来的历史是不是被替换过。
   *
   * 判据:已存的前 persistedCount 条,跟这次传进来的对应位置内容一致。
   * 不一致就说明中途被换掉了。
   */
  private historyReplaced(messages: Message[]): boolean {
    // 比已存的还短:历史被砍短了(/clear)
    if (messages.length < this.persistedCount) return true
    for (let index = 0; index < this.persistedCount; index++) {
      if (JSON.stringify(messages[index]) !== this.persistedContents[index]) {
        return true
      }
    }
    return false
  }

  /**
   * 删掉当前会话的旧内容,从头重写。
   *
   * 整个会话的序号会重新分配——历史被替换过之后,
   * 原来的序号对不上新的内容,续着写只会乱序。
   */
  private rewrite(messages: Message[]): number {
    const insert = this.database.prepare(
      'INSERT INTO messages (session_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    const clear = this.database.prepare('DELETE FROM messages WHERE session_id = ?')
    const touch = this.database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')

    const now = Date.now()
    this.database.exec('BEGIN')
    try {
      clear.run(this.currentSessionId)
      let seq = 0
      for (const message of messages) {
        insert.run(
          this.currentSessionId,
          seq,
          message.role,
          JSON.stringify(message),
          now,
        )
        seq++
      }
      touch.run(now, this.currentSessionId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }

    this.persistedCount = messages.length
    this.persistedContents = messages.map((message) => JSON.stringify(message))
    return messages.length
  }

  /**
   * 切换到另一个会话。
   *
   * 切之前要先把当前会话存盘——不然这一轮的消息会丢。
   * 切完重置计数,下一次 sync 会从头写新会话的内容。
   */
  switchSession(sessionId: string, messages: Message[]): void {
    if (this.closed) throw new Error('会话存储已关闭')
    if (sessionId === this.currentSessionId) return

    // 当前会话先落盘
    this.sync(messages)

    this.currentSessionId = sessionId
    this.ensureSessionRow()
    // 新会话的消息数从头算
    this.persistedCount = 0
    this.persistedContents = []
  }

  /**
   * 开一个新会话。
   *
   * 返回新会话的 ID。旧会话的内容保留在库里,可以用 /resume 切回来。
   */
  createSession(messages: Message[], sessionId?: string): string {
    if (this.closed) throw new Error('会话存储已关闭')
    // 旧会话先落盘
    this.sync(messages)

    const newSessionId = sessionId ?? generateSessionId()
    this.currentSessionId = newSessionId
    this.ensureSessionRow()
    this.persistedCount = 0
    this.persistedContents = []
    return newSessionId
  }

  /** 关闭数据库。进程退出前调用,确保数据落盘 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  // 旧库升级:sessions 原来没有 title 列。
  private ensureTitleColumn(): void {
    const columns = this.database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    if (columns.some((column) => column.name === 'title')) return
    this.database.exec('ALTER TABLE sessions ADD COLUMN title TEXT')
  }

  // 确保 sessions 表里有当前会话的行,方便外部工具查看有哪些会话
  private ensureSessionRow(): void {
    const now = Date.now()
    this.database
      .prepare(
        'INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at',
      )
      .run(this.currentSessionId, now, now)
  }

  /** 列出数据库里所有会话的 ID,按更新时间倒序 */
  listSessions(): string[] {
    const rows = this.database
      .prepare('SELECT id FROM sessions ORDER BY updated_at DESC')
      .all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  /**
   * 列出所有会话的详情,按更新时间倒序。
   *
   * 消息条数一并查出来,列表里直接显示,用户不用逐个点进去看。
   */
  listSessionDetails(): SessionDetail[] {
    const rows = this.database
      .prepare(
        'SELECT s.id AS id, s.updated_at AS updatedAt, s.title AS title, ' +
          '(SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount ' +
          'FROM sessions s ORDER BY s.updated_at DESC',
      )
      .all() as Array<{ id: string; updatedAt: number; messageCount: number; title: string | null }>

    return rows.map((row) => ({
      id: row.id,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount,
      title: row.title?.trim() ? row.title.trim() : null,
    }))
  }
}

/** 一个会话的概要信息 */
export interface SessionDetail {
  /** 会话 ID */
  id: string
  /** 最后更新时间(毫秒时间戳) */
  updatedAt: number
  /** 消息条数 */
  messageCount: number
  /** 小模型生成的标题。没有就是 null */
  title: string | null
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
