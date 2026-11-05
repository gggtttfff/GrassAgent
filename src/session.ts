// src/session.ts
// 会话存储 —— 追加式 JSONL,带文件轮转和并发写保护。
//
// 要解决的三个问题:
// 1. 轮转:session.jsonl 无限增长,跑久了很大。超过阈值就滚动成备份文件。
// 2. 行交错:多进程写同一文件,逐条 append 可能交错,JSONL 行会损坏。
// 3. 语义交错:两个进程往同一个对话交替写消息,即使文件没坏,语义也是错的。
//
// 锁的粒度因此是"会话所有权"(进程生命周期级),不是只保护单次写。
// 单次写锁只能防住第 2 点,第 3 点防不住——两个进程轮流写,
// 对话上下文会互相污染。
//
// 借鉴 pi 的思路:pi 的 session-manager 用带 header 的 entry 格式,
// 每条消息一个文件条目,天然避免行交错。代价是格式复杂、恢复慢。
// 这里保持纯 JSONL 的简洁,用锁文件解决并发。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { normalizeMessage, type Message } from './messages.ts'

/** 会话文件被别的进程占用时抛这个 */
export class SessionLockError extends Error {
  /** 持锁进程的 pid,拿不到时是 undefined */
  readonly holderPid: number | undefined
  readonly lockFilePath: string

  constructor(message: string, details: { holderPid?: number; lockFilePath: string }) {
    super(message)
    this.name = 'SessionLockError'
    this.holderPid = details.holderPid
    this.lockFilePath = details.lockFilePath
  }
}

export interface SessionStoreOptions {
  /** 会话文件路径 */
  filePath: string
  /** 超过这个字节数就轮转。默认 5MB */
  maxFileBytes?: number
  /** 保留几个备份文件。默认 5 */
  maxBackupFiles?: number
  /** 抢锁最多等多久(毫秒)。默认 5000 */
  lockTimeoutMs?: number
  /** 锁文件超过这个时间没更新就认为是残留锁。默认 60 秒 */
  staleLockMs?: number
}

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_BACKUP_FILES = 5
const DEFAULT_LOCK_TIMEOUT_MS = 5000
const DEFAULT_STALE_LOCK_MS = 60_000
const LOCK_RETRY_INTERVAL_MS = 100

// 锁文件里的内容,便于排障时看出是谁占着
interface LockContent {
  pid: number
  acquiredAt: number
}

// 等待一段时间
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// 判断进程是否还活着。
// EPERM 表示进程存在但当前用户无权发信号,也算活着。
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 会话存储。
 *
 * 用法:
 *   const store = await SessionStore.open({ filePath })
 *   const messages = await store.load()
 *   await store.sync(messages)   // 传完整列表,只写新增部分
 *   await store.release()
 */
export class SessionStore {
  readonly filePath: string
  readonly maxFileBytes: number
  readonly maxBackupFiles: number

  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number
  private readonly lockFilePath: string
  private readonly backupFilePaths: string[]

  // 已持久化的消息数。只追加新增的,避免重复写。
  private persistedCount = 0
  // 是否持有锁。持有时析构要负责释放。
  private lockHeld = false

  private constructor(options: SessionStoreOptions) {
    this.filePath = path.resolve(options.filePath)
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxBackupFiles = options.maxBackupFiles ?? DEFAULT_MAX_BACKUP_FILES
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
    this.lockFilePath = `${this.filePath}.lock`
    this.backupFilePaths = buildBackupPaths(this.filePath, this.maxBackupFiles)
  }

  /**
   * 打开会话存储并获取锁。
   * 拿不到锁说明别的进程正在用这个会话文件。
   */
  static async open(options: SessionStoreOptions): Promise<SessionStore> {
    const store = new SessionStore(options)
    await store.acquireLock()
    return store
  }

  /**
   * 读取历史消息。
   * 按时间顺序拼接当前文件和所有备份文件:最旧的备份在前,当前文件在后。
   */
  async load(): Promise<Message[]> {
    const messages: Message[] = []

    // 从最旧的备份读到最新的备份,最后读当前文件
    for (const backupPath of [...this.backupFilePaths].reverse()) {
      messages.push(...await readMessagesFromFile(backupPath))
    }
    messages.push(...await readMessagesFromFile(this.filePath))

    this.persistedCount = messages.length
    return messages
  }

  /**
   * 把完整会话同步到存储。只写 persistedCount 之后的新增部分。
   *
   * 注意:参数是**完整的会话消息列表**,不是"要新增的消息"。
   * 名字叫 sync 是为了强调这一点——传增量会写不进去(切片后为空)。
   * 写入前检查是否需要轮转。
   */
  async sync(messages: Message[]): Promise<number> {
    const newMessages = messages.slice(this.persistedCount)
    if (newMessages.length === 0) return 0

    // 一次拼成整块写入。分多次 appendFile 会有行交错的窗口,
    // 单次 write 尽可能落在同一个系统调用里。
    const payload = newMessages.map((message) => JSON.stringify(message)).join('\n') + '\n'

    await fs.mkdir(path.dirname(this.filePath) || '.', { recursive: true })
    await this.rotateIfNeeded(Buffer.byteLength(payload))

    await fs.appendFile(this.filePath, payload, 'utf-8')
    this.persistedCount = messages.length
    return newMessages.length
  }

  /** 释放锁。进程退出前调用,否则锁文件会残留到 staleLockMs 过期 */
  async release(): Promise<void> {
    if (!this.lockHeld) return
    this.lockHeld = false
    try {
      await fs.rm(this.lockFilePath, { force: true })
    } catch {
      // 锁文件删不掉不影响正确性:它会在 staleLockMs 后被当作残留锁接管
    }
  }

  // 获取锁文件。用 O_EXCL 独占创建,创建成功即拿到锁。
  private async acquireLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath) || '.', { recursive: true })
    const deadline = Date.now() + this.lockTimeoutMs

    while (true) {
      try {
        const handle = await fs.open(this.lockFilePath, 'wx')
        const content: LockContent = { pid: process.pid, acquiredAt: Date.now() }
        await handle.writeFile(JSON.stringify(content), 'utf-8')
        await handle.close()
        this.lockHeld = true
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      // 锁已存在:先看是不是残留锁
      if (await this.tryBreakStaleLock()) continue

      if (Date.now() >= deadline) {
        const holderPid = await readLockHolderPid(this.lockFilePath)
        const holder = holderPid ? `(pid ${holderPid})` : ''
        throw new SessionLockError(
          `会话文件 ${this.filePath} 正被其他进程占用${holder},等待 ${this.lockTimeoutMs}ms 未获得锁。` +
          `可以用 GRASSAGENT_SESSION_FILE 指定别的会话文件来同时运行多个实例。`,
          { holderPid, lockFilePath: this.lockFilePath },
        )
      }

      await delay(LOCK_RETRY_INTERVAL_MS)
    }
  }

  // 残留锁检测:锁文件太旧,或者持锁进程已经不在了,就可以接管。
  private async tryBreakStaleLock(): Promise<boolean> {
    let stats: Awaited<ReturnType<typeof fs.stat>>
    try {
      stats = await fs.stat(this.lockFilePath)
    } catch {
      // 锁文件刚被别人删掉,重试一次就能拿到
      return true
    }

    const age = Date.now() - stats.mtimeMs
    const holderPid = await readLockHolderPid(this.lockFilePath)

    // 持锁进程已死:锁是残留的,可以直接接管
    if (holderPid !== undefined && !isProcessAlive(holderPid)) {
      await this.removeLockFile()
      return true
    }

    // 锁文件太久没更新:持锁进程可能卡死了
    if (age > this.staleLockMs) {
      await this.removeLockFile()
      return true
    }

    return false
  }

  private async removeLockFile(): Promise<void> {
    try {
      await fs.rm(this.lockFilePath, { force: true })
    } catch {
      // 删不掉就等下一轮重试
    }
  }

  // 超过阈值就轮转:当前文件变成 .1,原 .1 变成 .2,依次后移,最旧的丢掉。
  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentSize = 0
    try {
      const stats = await fs.stat(this.filePath)
      currentSize = stats.size
    } catch {
      return // 文件还不存在,不需要轮转
    }

    if (currentSize + incomingBytes <= this.maxFileBytes) return

    // 从最旧的开始往后移,避免覆盖
    for (let index = this.backupFilePaths.length - 1; index >= 1; index--) {
      const source = this.backupFilePaths[index - 1]
      const target = this.backupFilePaths[index]
      await this.renameIfExists(source, target)
    }
    // 当前文件变成第一个备份
    await this.renameIfExists(this.filePath, this.backupFilePaths[0])
  }

  // 重命名文件。Windows 上目标存在时 rename 会失败,所以先删目标。
  private async renameIfExists(source: string, target: string): Promise<void> {
    try {
      await fs.access(source)
    } catch {
      return // 源文件不存在,跳过
    }
    try {
      await fs.rm(target, { force: true })
    } catch {
      // 目标删不掉就放弃这次轮转,不能因为轮转失败而丢数据
      return
    }
    try {
      await fs.rename(source, target)
    } catch {
      // 轮转失败不致命:主文件还在,继续写就行
    }
  }
}

// 计算备份文件路径:session.jsonl -> session.1.jsonl, session.2.jsonl ...
// 返回顺序是「最新的在前」,轮转时正好从后往前移。
function buildBackupPaths(filePath: string, count: number): string[] {
  const directory = path.dirname(filePath)
  const extension = path.extname(filePath)
  const baseName = path.basename(filePath, extension)
  const paths: string[] = []
  for (let index = 0; index < count; index++) {
    paths.push(path.join(directory, `${baseName}.${index + 1}${extension}`))
  }
  return paths
}

// 读一个 JSONL 文件里的消息。坏行跳过,不丢整个文件。
async function readMessagesFromFile(filePath: string): Promise<Message[]> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch {
    return [] // 文件不存在
  }

  const lines = content.split('\n').filter(Boolean)
  return lines.flatMap((line) => {
    try {
      const normalized = normalizeMessage(JSON.parse(line) as unknown)
      return normalized ? [normalized] : []
    } catch {
      return []
    }
  })
}

// 读锁文件里的持锁 pid
async function readLockHolderPid(lockFilePath: string): Promise<number | undefined> {
  try {
    const content = await fs.readFile(lockFilePath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<LockContent>
    return typeof parsed.pid === 'number' ? parsed.pid : undefined
  } catch {
    return undefined
  }
}
