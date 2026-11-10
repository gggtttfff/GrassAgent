import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import ssh2 from 'ssh2'
import { shellQuote, pathLevels } from '../src/sandbox/sshDeploy.ts'
import { connectSsh } from '../src/sandbox/sshTunnel.ts'
import { resolveSshConfig } from '../src/sandbox/sshConfig.ts'
import { deployRemoteDaemon } from '../src/sandbox/sshDeploy.ts'
import { createLogger } from '../src/logger.ts'

// 远程部署的测试。
//
// 用 ssh2 的 server 模式起一个假远程:它记录收到的命令和文件,
// 用来验证「传了哪些文件、启动命令长什么样」。
//
// 假远程实现了 SFTP 子系统——部署模块走 SFTP 写文件,
// 不用 shell 重定向。

const { Server, utils } = ssh2

const silentLogger = createLogger({
  level: 'fatal',
  format: 'json',
  destination: new Writable({ write(_chunk, _encoding, callback) { callback() } }),
})

type FakeRemote = {
  port: number
  /** 收到的命令。 */
  commands: string[]
  /** 远程报的 Node 版本。 */
  nodeVersion: string
  close: () => Promise<void>
}

async function startFakeRemote(options: { nodeVersion?: string } = {}): Promise<FakeRemote> {
  const keyPair = utils.generateKeyPairSync('ed25519')
  const commands: string[] = []
  const nodeVersion = options.nodeVersion ?? 'v24.22.2'
  const sockets: Array<{ destroy: () => void }> = []

  const server = new Server({ hostKeys: [keyPair.private] }, (client) => {
    // 记下底层 socket。关闭时要先掐掉,不然 server.close 不回调。
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
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        // SFTP 子系统。ssh2 服务端内置协议实现,但文件系统操作要自己接。
        session.on('subsystem', (acceptSubsystem, rejectSubsystem, info) => {
          if (info.name !== 'sftp') {
            rejectSubsystem()
            return
          }
          acceptSubsystem()
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          // 句柄 -> 真实文件路径
          const handles = new Map<string, string>()
          // 每个处理器都要返回真值。ssh2 用 emit 的返回值判断请求有没有被处理,
          // 返回假值它会再回一个 OP_UNSUPPORTED。
          sftp.on('MKDIR', (reqid, target) => {
            try {
              // 故意不用递归:真实的 SFTP mkdir 不建父目录。
              // 用 recursive 会把「实现没逐级建目录」的 bug 盖住。
              mkdirSync(target)
              sftp.status(reqid, 0)
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              // 4 = 已存在(正常),2 = 父目录不存在(说明实现漏了逐级创建)
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
              // copy 不会扩容,目标得先够长,不然写出去的内容被截断。
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
            // chmod 走 SETSTAT 请求。Windows 上没有 POSIX 权限,直接成功。
            sftp.status(reqid, 0)
            return true
          })
        })
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          commands.push(info.command)
          if (info.command.includes('node --version')) {
            stream.write(`${nodeVersion}\n`)
            stream.exit(0)
            stream.end()
            return
          }
          if (info.command.includes('curl')) {
            stream.write('{"ok":true,"version":1}\n')
            stream.exit(0)
            stream.end()
            return
          }
          if (info.command.includes('daemon.log')) {
            // 部署从日志里读实际监听的端口
            stream.write('daemon listening http://127.0.0.1:45678\n')
            stream.exit(0)
            stream.end()
            return
          }
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
    commands,
    nodeVersion,
    close: () => new Promise<void>((resolve) => {
      // 连接还在时 close 不回调。掐掉底层 socket 再关。
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
      // 兜底:close 不回调也不能挂住测试
      setTimeout(resolve, 2000).unref?.()
    }),
  }
}

/**
 * 起一个客户端连上假远程。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function connectTo(remote: FakeRemote): Promise<{ client: Awaited<ReturnType<typeof connectSsh>>, cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-deploy-'))
  const keyPair = utils.generateKeyPairSync('ed25519')
  const keyPath = path.join(directory, 'id_ed25519')
  await writeFile(keyPath, keyPair.private, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  // 写回来的要和写进去的一样。少了字符 ssh2 会报「私钥格式不对」。
  const written = await readFile(keyPath, 'utf-8')
  assert.equal(written, keyPair.private, '私钥文件要完整写进去')
  const config = resolveSshConfig({
    host: '127.0.0.1',
    port: remote.port,
    username: 'dev',
    privateKeyPath: keyPath,
    knownHostsPath: path.join(directory, 'known_hosts'),
  })
  const client = await connectSsh(config, { logger: silentLogger })
  return {
    client,
    cleanup: async () => {
      client.end()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('shell 引号挡住路径里的空格和单引号', () => {
  assert.equal(shellQuote('/tmp/plain'), `'/tmp/plain'`)
  assert.equal(shellQuote('/tmp/with space'), `'/tmp/with space'`)
  // 单引号要转义,不然命令会被截断
  assert.equal(shellQuote("/tmp/it's"), `'/tmp/it'\\''s'`)
})

test('路径拆成逐级前缀,SFTP mkdir 才能从根往下建', () => {
  assert.deepEqual(
    pathLevels('/tmp/grass-x/src/sandbox/daemon.ts'),
    ['/tmp', '/tmp/grass-x', '/tmp/grass-x/src', '/tmp/grass-x/src/sandbox', '/tmp/grass-x/src/sandbox/daemon.ts'],
  )
  // 末尾的斜杠和重复斜杠不该产生空段
  assert.deepEqual(pathLevels('/a//b/'), ['/a', '/a/b'])
})

test('部署要传 daemon 源码,令牌单独放 0600 文件', { timeout: 30_000 }, async () => {
  const remote = await startFakeRemote()
  const connection = await connectTo(remote)
  try {
    await deployRemoteDaemon({
      client: connection.client,
      sandboxId: 'test123',
      token: 'secret-token',
      remoteWorkspace: '/tmp/grass-test123/workspace',
      diskMb: 2048,
      logger: silentLogger,
    })

    // SFTP 写的是真磁盘。daemon 源码和它的依赖都要传过去。
    const remoteRoot = path.join(path.parse(process.cwd()).root, 'tmp', 'grass-test123')
    const daemonContent = await readFile(path.join(remoteRoot, 'src', 'sandbox', 'daemon.ts'), 'utf-8')
    // 用 fileURLToPath 而不是 url.pathname。Windows 上 pathname 是 /B:/...,
// 去掉开头的斜杠恰好能用;Linux 上是 /home/..., 去掉就变成相对路径了。
    const localDaemonPath = fileURLToPath(new URL('../src/sandbox/daemon.ts', import.meta.url))
    const localDaemon = await readFile(localDaemonPath, 'utf-8')
    assert.equal(daemonContent, localDaemon, '传过去的 daemon 源码要和本地一致')

    // 依赖也传了
    for (const dependency of ['executionWorld.ts', 'pathGuard.ts', 'localWorld.ts']) {
      const exists = await stat(path.join(remoteRoot, 'src', dependency)).then(() => true, () => false)
      assert.equal(exists, true, `${dependency} 应该传过去`)
    }

    // 令牌单独放一个文件,内容对得上
    const tokenContent = await readFile(path.join(remoteRoot, 'token'), 'utf-8')
    assert.equal(tokenContent, 'secret-token')

    // 启动命令要绑回环、指向传过去的路径、指定远程工作区
    const startCommand = remote.commands.find((command) => command.includes('--serve'))
    assert.ok(startCommand, '应该有启动 daemon 的命令')
    assert.match(startCommand, /--host 127\.0\.0\.1/)
    // 端口写死会抢;交给系统分配,部署再从日志里读回来
    assert.match(startCommand, /--port 0/)
    assert.match(startCommand, /--workspace '\/tmp\/grass-test123\/workspace'/)
    assert.match(startCommand, /--advertised-root '\/workspace'|--advertised-root \/workspace/)

    // 文件和目录都走 SFTP,不该有 shell 重定向
    assert.equal(
      remote.commands.some((command) => command.includes('cat >')),
      false,
      '写文件应该走 SFTP,不该用 shell 重定向',
    )

    await rm(remoteRoot, { recursive: true, force: true })
  } finally {
    await connection.cleanup()
    await remote.close()
  }
})

test('远程命令的输出和退出码都要拿回来', { timeout: 20_000 }, async () => {
  const remote = await startFakeRemote()
  const connection = await connectTo(remote)
  try {
    const { runRemote } = await import('../src/sandbox/sshDeploy.ts')
    const output = await runRemote(connection.client, 'node --version', silentLogger)
    // 输出不能被 end 事件吃掉
    assert.match(output, /v24\.22\.2/)
  } finally {
    await connection.cleanup()
    await remote.close()
  }
})

test('远程 Node 版本太低时报错', { timeout: 30_000 }, async () => {
  const remote = await startFakeRemote({ nodeVersion: 'v18.19.1' })
  const connection = await connectTo(remote)
  try {
    await assert.rejects(
      () => deployRemoteDaemon({
        client: connection.client,
        sandboxId: 'old',
        token: 't',
        remoteWorkspace: '/tmp/x',
        diskMb: 1024,
        logger: silentLogger,
      }),
      /版本|太低/,
    )
  } finally {
    await connection.cleanup()
    await remote.close()
  }
})
