// src/executionWorld.ts
// 文件和命令面对的那一块世界。本地和远程实现同一份接口,
// agent 循环只看到工具返回的字符串,不关心字节在哪台机器上。

/** 沙盒能碰到的范围。审批是另一条路,不写在这个模式里。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * 一次调用的沙盒策略。
 * workspaceRoot 是已经解析过软链的工作区根。远程世界里它是容器内的 /workspace。
 */
export type SandboxPolicy = {
  mode: SandboxMode
  workspaceRoot: string
}

/** 一处精确替换。顺序和原子性由世界的 edit 保证。 */
export type TextEdit = {
  old_string: string
  new_string: string
}

/**
 * 即将执行的 argv,不是再包一层 shell 的字符串。
 * run_bash 传入 ['bash', '-c', command],世界原样执行。
 */
export type ExecRequest = {
  argv: readonly string[]
  cwd: string
  timeoutMs: number
}

export type ExecResult = {
  exitCode: number
  stdout: string
  stderr: string
  aborted: boolean
  timedOut: boolean
}

/**
 * 目录里的一个条目。size 和 mtimeMs 让调用方能判断文件有没有变过。
 */
export type DirectoryEntry = {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
  mtimeMs?: number
}

/**
 * 文件和命令读同一份根。
 * sandboxId 在本地世界为 null。远程世界是控制面返回的 id。
 */
export interface ExecutionWorld {
  readonly sandboxId: string | null
  readonly workspaceRoot: string
  readonly policy: SandboxPolicy
  /** 读取文件。超长内容只返回尾部,全文留在这个世界自己的临时区。作者：Pieory 创建日期：2025-07-18 */
  read(filePath: string): Promise<string>
  /**
   * 读取文件全文,不做输出上限的截断。
   * 技能、配置这类要原样读的文件走这条——普通 read 只给尾部,会把正文读坏。
   * 作者：Pieory 创建日期：2025-07-18
   */
  readRaw(filePath: string): Promise<string>
  /** 列目录。只返回直接子项,不含递归。作者：Pieory 创建日期：2025-07-18 */
  list(directoryPath: string): Promise<DirectoryEntry[]>
  /** 覆盖写入。返回解析后的路径,供工具拼给模型看的回执。作者：Pieory 创建日期：2025-07-18 */
  write(filePath: string, content: string): Promise<string>
  /**
   * 按顺序做唯一替换,全部成功才落盘。
   * 返回解析后的路径。作者：Pieory 创建日期：2025-07-18
   */
  edit(filePath: string, edits: readonly TextEdit[]): Promise<string>
  /** 执行 argv。stdout/stderr 已经按这个世界的上限收过尾。作者：Pieory 创建日期：2025-07-18 */
  exec(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult>
  /** 会话结束时释放远程资源。本地世界什么都不做。作者：Pieory 创建日期：2025-07-18 */
  close(): Promise<void>
}

/** 控制面或 daemon 断开。调用方必须把它写成工具结果,不能改绑本机工作区。 */
export class SandboxUnavailableError extends Error {
  constructor(message = 'sandbox unavailable') {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/** 当前沙盒模式不允许这次动作。不降级到更宽的模式。 */
export class PolicyDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyDeniedError'
  }
}

/** 字节不是合法 UTF-8。静默替换成 U+FFFD 会让模型以为文件就是那样。 */
export class EncodingError extends Error {
  constructor(filePath: string, detail: string) {
    super(`无法按 UTF-8 解码 ${filePath}: ${detail}`)
    this.name = 'EncodingError'
  }
}
