import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { Writable } from 'node:stream'
import ssh2 from 'ssh2'
import { createSshBackend } from '../src/sandbox/sshBackend.ts'
import { createLogger } from '../src/logger.ts'

// SSH 后端的测试。
//
// 用 ssh2 的 server 模式起一个假远程。它实现 SFTP(让部署能传文件)
// 和 exec(让命令能跑),并在远程起一个真的 HTTP 服务冒充 daemon。
//
// 这样整条链路——部署、开隧道、转发调用——都在本地跑通。

const { Server, utils } = ssh2

const silentLogger = createLogger({
  level: 'fatal',
  format: 'json',
  destination: new Writable({ write(_chunk, _encoding, callback) { callback() } }),
})

type FakeRemote = {
  port: number
  close: () => Promise<void>
}

/**
 * 起一个假远程:它会真的起一个 HTTP 服务,端口就是隧道要转的地方。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function startFakeRemote(): Promise<FakeRemote> {
  const keyPair = utils.generateKeyPairSync('ed25519')
  const sockets: Array<{ destroy: () => void }> = []
  const forwardedSockets: Array<{ destroy: () => void }> = []

  // 冒充远程 daemon:收 /call,回健康检查
  const daemonServer = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { kind: string }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, version: 1, kind: body.kind }))
    })
  })
  await new Promise<void>((resolve) => daemonServer.listen(0, '127.0.0.1', () => resolve()))
  const daemonPort = (daemonServer.address() as { port: number }).port

  const server = new Server({ hostKeys: [keyPair.private] }, (client) => {
    const socket = (client as unknown as { _sock?: { destroy: () => void } })._sock
    if (socket) sockets.push(socket)
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') {
        ctx.accept()
        return
      }
      ctx.reject()
    })
    client.on('ready', () => {
      // 隧道用 forwardOut,服务端这边收到的是 tcpip 请求。
      // 把通道接到冒充的 daemon 上,数据双向转发。
      client.on('tcpip', (acceptTcpip, rejectTcpip, info) => {
        // 端口是 daemon 自己挑的,日志里报的就是假 daemon 的真实端口,直接连
        const channel = acceptTcpip()
        const socket = connect(info.destPort, info.destIP)
        // 记下来,关闭时要一起掐掉,不然进程退不出去
        forwardedSockets.push(socket)
        socket.on('connect', () => {
          socket.pipe(channel).pipe(socket)
        })
        socket.on('error', () => {
          channel.destroy()
        })
        channel.on('close', () => socket.destroy())
        channel.on('error', () => socket.destroy())
      })
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('subsystem', (acceptSubsystem, rejectSubsystem, info) => {
          if (info.name !== 'sftp') {
            rejectSubsystem()
            return
          }
          acceptSubsystem()
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map<string, string>()
          sftp.on('MKDIR', (reqid, target) => {
            try {
              // 故意不用递归:真实的 SFTP mkdir 不建父目录。
              mkdirSync(target)
              sftp.status(reqid, 0)
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              sftp.status(reqid, code === 'EEXIST' ? 4 : 2)
            }
            return true
          })
          sftp.on('OPEN', (reqid, filename) => {
            const handle = `h${handles.size}`
            handles.set(handle, filename)
            try {
              writeFileSync(filename, '')
              sftp.handle(reqid, Buffer.from(handle))
            } catch {
              sftp.status(reqid, 2)
            }
            return true
          })
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const target = handles.get(handle.toString())
            if (!target) {
              sftp.status(reqid, 4)
              return true
            }
            try {
              const existing = readFileSync(target)
              const needed = offset + data.length
              const buffer = Buffer.alloc(Math.max(existing.length, needed))
              existing.copy(buffer, 0)
              data.copy(buffer, offset)
              writeFileSync(target, buffer)
              sftp.status(reqid, 0)
            } catch {
              sftp.status(reqid, 4)
            }
            return true
          })
          sftp.on('CLOSE', (reqid) => {
            sftp.status(reqid, 0)
            return true
          })
          sftp.on('SETSTAT', (reqid: number) => {
            sftp.status(reqid, 0)
            return true
          })
        })
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          if (info.command.includes('node --version')) {
            stream.write('v24.22.2\n')
            stream.exit(0)
            stream.end()
            return
          }
          if (info.command.includes('curl')) {
            // 探活打到真的 daemon 服务上
            callDaemon(daemonPort, info.command).then((body) => {
              stream.write(body)
              stream.exit(0)
              stream.end()
            }, () => {
              stream.write('')
              stream.exit(1)
              stream.end()
            })
            return
          }
          if (info.command.includes('daemon.log')) {
            // 部署会从日志里读实际监听的端口
            stream.write(`daemon listening http://127.0.0.1:${daemonPort}\n`)
            stream.exit(0)
            stream.end()
            return
          }
          // 别的命令:启动 daemon 的 nohup 之类,回成功就行
          stream.write('')
          stream.exit(0)
          stream.end()
        })
      })
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as { port: number }
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      for (const socket of forwardedSockets) socket.destroy()
      daemonServer.closeAllConnections?.()
      daemonServer.close()
      server.close(() => resolve())
      setTimeout(resolve, 2000).unref?.()
    }),
  }
}

/**
 * 把 curl 命令行翻译成一次真实的 HTTP 请求,返回响应体。
 *
 * 假远程不需要真的调 curl——它只要把请求打到 daemon 上。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
function callDaemon(port: number, command: string): Promise<string> {
  const bodyMatch = command.match(/--data\s+'([^']*)'/)
  const body = bodyMatch ? bodyMatch[1] : '{}'
  const tokenMatch = command.match(/Bearer\s+(\S+)/)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/call',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokenMatch ? tokenMatch[1] : ''}`,
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      let received = ''
      response.on('data', (chunk: Buffer) => { received += chunk.toString() })
      response.on('end', () => resolve(received))
    })
    request.on('error', reject)
    // 声明了 content-length 就必须真的把体写出去,否则服务端一直等
    request.end(body)
  })
}

async function makeKeyFile(): Promise<{ keyPath: string; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-sshbackend-'))
  const keyPath = path.join(directory, 'id_ed25519')
  await writeFile(keyPath, utils.generateKeyPairSync('ed25519').private, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  return { keyPath, directory }
}

test('SSH 后端:创建沙盒后能通过隧道转发调用', { timeout: 40_000 }, async () => {
  const remote = await startFakeRemote()
  const { keyPath, directory } = await makeKeyFile()
  try {
    const backend = createSshBackend({
      host: '127.0.0.1',
      port: remote.port,
      username: 'dev',
      privateKeyPath: keyPath,
      knownHostsPath: path.join(directory, 'known_hosts'),
      // 远程是 Linux,工作区用 POSIX 路径。部署会把它建出来。
      remoteWorkspace: '/tmp/grass-sb-workspace',
      logger: silentLogger,
    })

    const sandbox = await backend.provision({
      sandboxId: 'sb1',
      token: 'test-token-123456',
      image: '',
      repoUrl: '',
      credential: null,
      cpu: 1,
      memoryMb: 1024,
      diskMb: 1024,
      networkAllowlist: [],
      keep: false,
    })

    // 模型看到的根是 /workspace,不是远程的真实路径
    assert.equal(sandbox.workspaceRoot, '/workspace')
    assert.equal(sandbox.sandboxId, 'sb1')

    // 调用要能通过隧道送到远程 daemon
    const result = await sandbox.forward({
      version: 1,
      kind: 'health',
    })
    assert.equal(result.ok, true)
    assert.equal(result.version, 1)

    await sandbox.destroy({ removeVolume: true })
  } finally {
    await remote.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SSH 后端:挂回返回 null,不伪造空工作区', { timeout: 20_000 }, async () => {
  const remote = await startFakeRemote()
  const { keyPath, directory } = await makeKeyFile()
  try {
    const backend = createSshBackend({
      host: '127.0.0.1',
      port: remote.port,
      username: 'dev',
      privateKeyPath: keyPath,
      knownHostsPath: path.join(directory, 'known_hosts'),
      logger: silentLogger,
    })
    // 远程目录跟着 daemon 一起删了,挂不回就该明说,不能给个空目录顶替
    assert.equal(await backend.attach('missing'), null)
  } finally {
    await remote.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SSH 后端:远程连不上时创建失败,不留半成品', { timeout: 20_000 }, async () => {
  const { keyPath, directory } = await makeKeyFile()
  try {
    const backend = createSshBackend({
      // 这个端口没人听
      host: '127.0.0.1',
      port: 1,
      username: 'dev',
      privateKeyPath: keyPath,
      knownHostsPath: path.join(directory, 'known_hosts'),
      timeoutMs: 3000,
      logger: silentLogger,
    })
    await assert.rejects(
      () => backend.provision({
        sandboxId: 'sb2',
        token: 'test-token-123456',
        image: '',
        repoUrl: '',
        credential: null,
        cpu: 1,
        memoryMb: 1024,
        diskMb: 1024,
        networkAllowlist: [],
        keep: false,
      }),
      /ECONNREFUSED|连接|connect|socket/i,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
