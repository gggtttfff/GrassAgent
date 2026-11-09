// src/sandbox/daemon.ts
// 沙盒里的窄服务。只听回环,每次调用再查一次路径。
// 控制面通过本机回环或容器内的 proxy 进来,端口不对公网发布。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import {
  EncodingError,
  PolicyDeniedError,
  type SandboxMode,
} from '../executionWorld.ts'
import { parseJson } from '../jsonSafety.ts'
import { runArgv } from '../localWorld.ts'
import { presentFile } from '../outputBound.ts'
import { createPathGuard, PathOutsideWorkspaceError, type PathGuard } from '../pathGuard.ts'
import { applyEdits } from '../textEdit.ts'
import { TextEditError } from '../textEdit.ts'
import {
  advertisedFromLocal,
  advertisedPath,
  ADVERTISED_WORKSPACE,
  localPathFromAdvertised,
} from './lexicalPath.ts'
import {
  MAX_CALL_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  tokenMatches,
  type SandboxCall,
  type SandboxResult,
} from './protocol.ts'
import { sandboxProcessEnv } from './secrets.ts'

export type DaemonOptions = {
  localRoot: string
  token: string
  advertisedRoot?: string
  host?: string
  port?: number
  version?: number
  diskMb?: number
  mode?: SandboxMode
}

export type RunningDaemon = {
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * 启动 daemon。host 不是回环地址就拒绝,避免有人配成 0.0.0.0。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1') {
    throw new Error('沙盒服务只监听回环地址')
  }
  const advertisedRoot = options.advertisedRoot ?? ADVERTISED_WORKSPACE
  const version = options.version ?? SANDBOX_PROTOCOL_VERSION
  const pathGuard = await createPathGuard(options.localRoot)
  const diskBytes = (options.diskMb ?? 10240) * 1024 * 1024
  const mode = options.mode ?? 'workspace-write'

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      token: options.token,
      version,
      advertisedRoot,
      pathGuard,
      diskBytes,
      mode,
    }).catch((error: unknown) => {
      writeJson(response, 500, {
        ok: false,
        code: 'failed',
        error: (error as Error).message,
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('daemon 没有绑到 TCP 端口')
  }

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

type HandlerContext = {
  token: string
  version: number
  advertisedRoot: string
  pathGuard: PathGuard
  diskBytes: number
  mode: SandboxMode
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HandlerContext,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/call') {
    writeJson(response, 404, { ok: false, code: 'failed', error: '未知路径' })
    return
  }
  const header = request.headers.authorization ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!tokenMatches(provided, context.token)) {
    writeJson(response, 401, { ok: false, code: 'unauthorized', error: '令牌被拒绝' })
    return
  }

  const raw = await readLimitedBody(request, MAX_CALL_BYTES)
  let body: SandboxCall
  try {
    body = parseJson(raw) as SandboxCall
  } catch {
    writeJson(response, 400, { ok: false, code: 'failed', error: '请求不是合法 JSON' })
    return
  }
  if (body.version !== context.version) {
    writeJson(response, 200, {
      ok: false,
      code: 'version',
      error: `需要协议版本 ${context.version}`,
    })
    return
  }

  const abort = new AbortController()
  const stop = (): void => abort.abort()
  request.on('aborted', stop)
  response.on('close', () => {
    if (!response.writableEnded) stop()
  })

  const result = await dispatch(body, context, abort.signal)
  writeJson(response, 200, result)
}

async function dispatch(
  body: SandboxCall,
  context: HandlerContext,
  signal: AbortSignal,
): Promise<SandboxResult> {
  try {
    if (body.kind === 'health') {
      return { ok: true, version: context.version }
    }
    if (body.kind === 'read') {
      const resolved = await resolveCallPath(body.path ?? '', context)
      const content = await presentFile(resolved, context.pathGuard.workspace, (local) => (
        advertisedFromLocal(context.pathGuard.workspace, context.advertisedRoot, local)
      ))
      return { ok: true, version: context.version, content }
    }
    if (body.kind === 'write') {
      assertWritable(context.mode, '写入')
      const content = body.content ?? ''
      assertDisk(content, context.diskBytes)
      const resolved = await resolveCallPath(body.path ?? '', context)
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(path.dirname(resolved), { recursive: true })
      await writeFile(resolved, content, 'utf-8')
      return {
        ok: true,
        version: context.version,
        path: advertisedFromLocal(context.pathGuard.workspace, context.advertisedRoot, resolved),
      }
    }
    if (body.kind === 'edit') {
      assertWritable(context.mode, '编辑')
      const resolved = await resolveCallPath(body.path ?? '', context)
      const buffer = await readFile(resolved)
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch (error) {
        throw new EncodingError(resolved, (error as Error).message)
      }
      const edits = body.edits ?? []
      const advertised = advertisedFromLocal(context.pathGuard.workspace, context.advertisedRoot, resolved)
      const next = applyEdits(content, edits, advertised)
      assertDisk(next, context.diskBytes)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(resolved, next, 'utf-8')
      return { ok: true, version: context.version, path: advertised }
    }
    if (body.kind === 'exec') {
      if (context.mode === 'read-only') throw new PolicyDeniedError('只读沙盒拒绝执行命令')
      const cwd = await resolveCallPath(body.cwd || context.advertisedRoot, context)
      const result = await runArgv({
        argv: body.argv ?? [],
        cwd,
        timeoutMs: body.timeoutMs ?? 3000,
      }, cwd, context.pathGuard.workspace, signal, sandboxProcessEnv())
      return {
        ok: true,
        version: context.version,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        aborted: result.aborted,
        timedOut: result.timedOut,
      }
    }
    return { ok: false, code: 'failed', error: '未知调用' }
  } catch (error) {
    return errorResult(error)
  }
}

async function resolveCallPath(requested: string, context: HandlerContext): Promise<string> {
  const advertised = advertisedPath(context.advertisedRoot, requested)
  const local = localPathFromAdvertised(context.advertisedRoot, advertised, context.pathGuard.workspace)
  return context.pathGuard.resolve(local)
}

function assertWritable(mode: SandboxMode, action: string): void {
  if (mode === 'read-only') throw new PolicyDeniedError(`只读沙盒拒绝${action}`)
}

function assertDisk(content: string, diskBytes: number): void {
  if (Buffer.byteLength(content) > diskBytes) {
    throw new Error(`写入超过磁盘限额 ${diskBytes} 字节`)
  }
}

function errorResult(error: unknown): SandboxResult {
  if (error instanceof TextEditError) {
    return {
      ok: false,
      code: 'edit',
      error: error.message,
      reason: error.reason,
      index: error.index,
      count: error.count,
      filePath: error.filePath,
    }
  }
  if (error instanceof PolicyDeniedError) {
    return { ok: false, code: 'policy', error: error.message }
  }
  if (error instanceof EncodingError) {
    return { ok: false, code: 'encoding', error: error.message }
  }
  if (error instanceof PathOutsideWorkspaceError) {
    return { ok: false, code: 'path', error: error.message }
  }
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') {
    return { ok: false, code: 'failed', error: `没有权限访问: ${(error as Error).message}` }
  }
  if (code === 'EROFS') {
    return { ok: false, code: 'failed', error: `文件只读,写入被拒绝: ${(error as Error).message}` }
  }
  return { ok: false, code: 'failed', error: (error as Error).message }
}

function writeJson(response: ServerResponse, status: number, body: SandboxResult): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function readLimitedBody(request: IncomingMessage, limit: number): Promise<string> {
  // for-await 在这份 Node 上会把已经声明了 Content-Length 的请求体读成空串。
  // 用 data/end 事件才能拿到字节。
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const fail = (error: Error): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) {
        fail(new Error('请求体超过上限'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      resolve(Buffer.concat(chunks).toString('utf-8'))
    }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', fail)
  })
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  return process.argv[index + 1]
}

function isDaemonEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const base = path.basename(entry)
  return base === 'daemon.ts' || base === 'daemon.js' || base === 'daemon.mjs'
}

async function serveFromArgv(): Promise<void> {
  const tokenFile = readFlag('--token-file')
  const workspace = readFlag('--workspace') ?? ADVERTISED_WORKSPACE
  if (!tokenFile) throw new Error('缺少 --token-file')
  const token = (await readFile(tokenFile, 'utf-8')).trim()
  const daemon = await startDaemon({
    localRoot: workspace,
    advertisedRoot: readFlag('--advertised-root') ?? ADVERTISED_WORKSPACE,
    token,
    host: readFlag('--host') ?? '127.0.0.1',
    port: Number(readFlag('--port') ?? 8765),
    mode: (readFlag('--mode') as SandboxMode | undefined) ?? 'workspace-write',
    diskMb: Number(readFlag('--disk-mb') ?? 10240),
  })
  process.stdout.write(`daemon listening ${daemon.url}\n`)
}

async function proxyFromArgv(): Promise<void> {
  const tokenFile = readFlag('--token-file')
  const port = readFlag('--port') ?? '8765'
  if (!tokenFile) throw new Error('缺少 --token-file')
  const token = (await readFile(tokenFile, 'utf-8')).trim()
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const response = await fetch(`http://127.0.0.1:${port}/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: Buffer.concat(chunks),
  })
  process.stdout.write(await response.text())
  if (!response.ok && response.status !== 200) process.exitCode = 1
}

if (isDaemonEntry() && process.argv.includes('--serve')) {
  serveFromArgv().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  })
}

if (isDaemonEntry() && process.argv.includes('--proxy')) {
  proxyFromArgv().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  })
}
