// src/sandbox/controlHttp.ts
// 控制面的 HTTP 服务。只绑回环。
//
// 和 controlServer.ts 分开:那个是命令行入口,这个是可以被复用的服务。
// openWorld.ts 要在本进程里起控制面,导入入口文件会带进副作用。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { parseJson } from '../jsonSafety.ts'
import {
  type ControlPlane,
  type CreateSandboxInput,
  type SandboxHandle,
} from './control.ts'
import { MAX_CALL_BYTES, type SandboxCall } from './protocol.ts'

export type ListeningControl = {
  url: string
  port: number
  close: () => Promise<void>
}

/**
 * 起一个控制面的 HTTP 服务。
 *
 * host 不是回环地址就拒绝——控制面暴露到网络等于开放任意沙盒创建。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function listenControl(
  plane: ControlPlane,
  options: { host?: string; port?: number } = {},
): Promise<ListeningControl> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1') throw new Error('控制面只监听回环地址')
  const server = createServer((request, response) => {
    void handle(plane, request, response).catch((error: unknown) => {
      writeJson(response, 500, { error: (error as Error).message })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('控制面没有绑到 TCP 端口')
  }
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await plane.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}

async function handle(
  plane: ControlPlane,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  try {
    if (request.method === 'POST' && url.pathname === '/v1/sandboxes') {
      const input = parseJson(await readBody(request)) as CreateSandboxInput
      const handle = await plane.create(input, bearer(request))
      writeJson(response, 201, handle)
      return
    }
    if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'sandboxes' && parts[3] === 'call') {
      const result = await plane.call(parts[2], bearer(request), parseJson(await readBody(request)) as SandboxCall)
      const status = !result.ok && result.code === 'unauthorized' ? 401 : 200
      writeJson(response, status, result)
      return
    }
    if (request.method === 'DELETE' && parts[0] === 'v1' && parts[1] === 'sandboxes' && parts.length === 3) {
      await plane.release(parts[2], bearer(request))
      writeJson(response, 204, {})
      return
    }
    if (request.method === 'POST' && parts[0] === 'v1' && parts[1] === 'sandboxes' && parts[3] === 'attach') {
      const body = parseJson(await readBody(request)) as { ttlMs?: number; sessionId?: string }
      const handle = await plane.attach(parts[2], body.ttlMs ?? 1_800_000, body.sessionId, bearer(request))
      writeJson(response, 200, handle)
      return
    }
    writeJson(response, 404, { error: '未知路径' })
  } catch (error) {
    const message = (error as Error).message
    const status = message.includes('不能挂回') || message.includes('不存在') ? 404 : 400
    writeJson(response, status, { error: message })
  }
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

function readBody(request: IncomingMessage): Promise<string> {
  // 和 daemon 一样:for-await 读不到带 Content-Length 的请求体。
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_CALL_BYTES) {
        reject(new Error('请求体超过上限'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    request.on('error', reject)
  })
}

function writeJson(response: ServerResponse, status: number, body: SandboxHandle | Record<string, unknown>): void {
  if (response.writableEnded) return
  if (status === 204) {
    response.writeHead(204)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
