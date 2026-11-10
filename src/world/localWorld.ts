// src/world/localWorld.ts
// 本机执行世界。路径规则沿用 pathGuard,命令和文件落在同一块工作区上。
// 默认 workspace-write,和改动之前的 Grass 一样,工作区内的调用不再询问。

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { assertEscalationAllowed, type ApprovalGate } from './approvalGate.ts'
import {
  EncodingError,
  PolicyDeniedError,
  type DirectoryEntry,
  type ExecRequest,
  type ExecResult,
  type ExecutionWorld,
  type SandboxMode,
  type SandboxPolicy,
  type TextEdit,
} from './executionWorld.ts'
import { captureStream, presentFile } from './outputBound.ts'
import { createPathGuard, type PathGuard } from '../core/pathGuard.ts'
import { applyEdits } from '../core/textEdit.ts'

export type LocalWorldOptions = {
  workspace?: string
  mode?: SandboxMode
  approval?: ApprovalGate
}

/**
 * 创建本地世界。danger-full-access 必须先经过审批,普通工具构造不出这种世界。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function createLocalWorld(options: LocalWorldOptions = {}): Promise<ExecutionWorld> {
  const requested = options.workspace ?? process.cwd()
  const mode = options.mode ?? 'workspace-write'
  if (mode === 'danger-full-access') {
    await assertEscalationAllowed(options.approval, 'danger-full-access')
  }
  const pathGuard = await createPathGuard(requested)
  const policy: SandboxPolicy = { mode, workspaceRoot: pathGuard.workspace }
  return new LocalWorld(pathGuard, policy)
}

class LocalWorld implements ExecutionWorld {
  readonly sandboxId = null
  readonly workspaceRoot: string
  readonly policy: SandboxPolicy
  private readonly pathGuard: PathGuard

  constructor(pathGuard: PathGuard, policy: SandboxPolicy) {
    this.pathGuard = pathGuard
    this.policy = policy
    this.workspaceRoot = policy.workspaceRoot
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async read(filePath: string): Promise<string> {
    const resolved = await this.resolveInside(filePath)
    try {
      return await presentFile(resolved, this.workspaceRoot)
    } catch (error) {
      if (error instanceof EncodingError) throw error
      throw fileAccessError(error, resolved)
    }
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async readRaw(filePath: string): Promise<string> {
    const resolved = await this.resolveInside(filePath)
    try {
      return decodeFile(await readFile(resolved), resolved)
    } catch (error) {
      if (error instanceof EncodingError) throw error
      throw fileAccessError(error, resolved)
    }
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async list(directoryPath: string): Promise<DirectoryEntry[]> {
    const resolved = await this.resolveInside(directoryPath)
    let entries
    try {
      entries = await readdir(resolved, { withFileTypes: true })
    } catch (error) {
      throw fileAccessError(error, resolved)
    }
    const result: DirectoryEntry[] = []
    for (const entry of entries) {
      const child = path.join(resolved, entry.name)
      let size: number | undefined
      let mtimeMs: number | undefined
      try {
        const stats = await stat(child)
        size = stats.size
        mtimeMs = stats.mtimeMs
      } catch {
        // 读不到就当没有这些信息,调用方只靠名字判断也够用
      }
      result.push({ name: entry.name, type: entryType(entry), size, mtimeMs })
    }
    return result
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async write(filePath: string, content: string): Promise<string> {
    this.assertWritable('写入')
    const resolved = await this.resolveInside(filePath)
    await mkdir(path.dirname(resolved), { recursive: true })
    try {
      await writeFile(resolved, content, 'utf-8')
    } catch (error) {
      throw fileAccessError(error, resolved)
    }
    return resolved
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async edit(filePath: string, edits: readonly TextEdit[]): Promise<string> {
    this.assertWritable('编辑')
    const resolved = await this.resolveInside(filePath)
    let content: string
    try {
      content = decodeFile(await readFile(resolved), resolved)
    } catch (error) {
      if (error instanceof EncodingError) throw error
      throw fileAccessError(error, resolved)
    }
    const next = applyEdits(content, edits, resolved)
    try {
      await writeFile(resolved, next, 'utf-8')
    } catch (error) {
      throw fileAccessError(error, resolved)
    }
    return resolved
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async exec(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    if (this.policy.mode === 'read-only') {
      // 本地做不到「这一次调用工作区不可写」,拒绝比猜命令会不会改文件更稳
      throw new PolicyDeniedError('只读沙盒拒绝执行命令')
    }
    if (signal?.aborted) {
      return { exitCode: 0, stdout: '', stderr: '', aborted: true, timedOut: false }
    }
    const cwd = this.policy.mode === 'danger-full-access'
      ? path.resolve(request.cwd)
      : await this.resolveInside(request.cwd)
    return runArgv(request, cwd, this.workspaceRoot, signal)
  }

  /** 作者：Pieory 创建日期：2025-07-18 */
  async close(): Promise<void> {}

  private assertWritable(action: string): void {
    if (this.policy.mode === 'read-only') {
      throw new PolicyDeniedError(`只读沙盒拒绝${action}`)
    }
  }

  private resolveInside(filePath: string): Promise<string> {
    if (this.policy.mode === 'danger-full-access') return Promise.resolve(path.resolve(filePath))
    return this.pathGuard.resolve(filePath)
  }
}

/**
 * 执行 argv。Windows 上没有 bash 时,把 bash -c 翻译成 cmd,本地行为才和原来的 exec 一致。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function runArgv(
  request: ExecRequest,
  cwd: string,
  workspaceRoot: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  const { file, args } = commandForPlatform(request.argv)
  const child = spawn(file, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let timedOut = false
  let aborted = false
  let spawnError: Error | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    stopProcessTree(child)
  }, request.timeoutMs)
  const onAbort = (): void => {
    aborted = true
    stopProcessTree(child)
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  child.once('error', (error) => {
    spawnError = error
    child.stdout?.destroy()
    child.stderr?.destroy()
  })

  const stdoutPromise = captureStream(child.stdout, workspaceRoot).catch(() => '')
  const stderrPromise = captureStream(child.stderr, workspaceRoot).catch(() => '')
  const exitCode = await new Promise<number>((resolve) => {
    child.once('error', () => resolve(127))
    child.once('close', (code) => resolve(code ?? 1))
  })
  clearTimeout(timeout)
  signal?.removeEventListener('abort', onAbort)

  const stdout = await stdoutPromise
  const stderr = spawnError
    ? `${spawnError.message}${await stderrPromise}`
    : await stderrPromise

  return {
    exitCode: spawnError ? 127 : exitCode,
    stdout,
    stderr,
    aborted,
    timedOut,
  }
}

/**
 * Windows 上 bash -c 会变成 cmd.exe,sleep 是 cmd 的子进程。
 * child.kill 只结束 cmd,管道要等 sleep 自己退出。taskkill /t 把整棵进程树杀掉。
 * 作者：Pieory 创建日期：2025-07-18
 */
function stopProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.unref()
    killer.once('error', () => {
      child.kill()
    })
    return
  }
  child.kill('SIGTERM')
}

function commandForPlatform(argv: readonly string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && argv[0] === 'bash' && argv[1] === '-c') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', argv[2] ?? ''],
    }
  }
  return { file: argv[0] || 'bash', args: [...argv.slice(1)] }
}

function fileAccessError(error: unknown, filePath: string): Error {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(`没有权限访问 ${filePath}`)
  }
  if (code === 'EISDIR') return new Error(`${filePath} 是目录,不能当文件读写`)
  if (code === 'EROFS') return new Error(`${filePath} 只读,写入被拒绝`)
  return error as Error
}

/**
 * 把 exec 结果收成和原来 run_bash 一样的文本。
 * stdout/stderr 在执行时已经按世界截过,这里不再写第二份临时文件。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function formatExecResult(result: ExecResult): string {
  if (result.aborted && !result.timedOut) return 'aborted'
  if (result.timedOut) return `[exit SIGTERM] ${result.stderr}${result.stdout}`
  if (result.exitCode !== 0) return `[exit ${result.exitCode}] ${result.stderr}${result.stdout}`
  return result.stderr ? `[stderr] ${result.stderr}\n[stdout] ${result.stdout}` : result.stdout
}

function decodeFile(buffer: Buffer, filePath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error) {
    throw new EncodingError(filePath, (error as Error).message)
  }
}

function entryType(entry: import('node:fs').Dirent): DirectoryEntry['type'] {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) return 'symlink'
  return 'other'
}
