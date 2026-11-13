import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import ssh2 from 'ssh2'
import { shellQuote, pathLevels } from '../../src/sandbox/sshDeploy.ts'
import { connectSsh } from '../../src/sandbox/sshTunnel.ts'
import { resolveSshConfig } from '../../src/sandbox/sshConfig.ts'
import { deployRemoteDaemon } from '../../src/sandbox/sshDeploy.ts'
import type { ProvisionProgress } from '../../src/sandbox/backend.ts'
import { createLogger } from '../../src/core/logger.ts'
import { generateTestKeyPair } from './testKeys.ts'

// 远程部署的测试。
//
// 用 ssh2 的 server 模式起一个假远程:它记录收到的命令和文件,
// 用来验证「传了哪些文件、启动命令长什么样」。
//
// 假远程实现了 SFTP 子系统——部署模块走 SFTP 写文件,
// 不用 shell 重定向。

const { Server } = ssh2

const silentLogger = createLogger({
  level: 'fatal',
  format: 'json',
  destination: new Writable({ write(_chunk, _encoding, callback) { callback() } }),
})

/** 把远程 POSIX 路径换成假远程真正写盘的位置。 */
function toLocalPath(remotePath: string): string {
  return path.join(path.parse(process.cwd()).root, remotePath)
}

/**
 * 这个测试文件专用的远程根目录。
 *
 * 不能和其他测试文件共用 /tmp:node:test 会并行跑多个文件,
 * 两边同时部署同一份源码时会抢同一个 hash 目录,
 * 输的那边会留下临时目录。
 */
const REMOTE_ROOT = '/tmp/grass-it-deploy'

type FakeRemote = {
  port: number
  /** 收到的命令。 */
  commands: string[]
  /** 以写方式打开的文件路径。用来判断有没有重复上传。 */
  writes: string[]
  /** 远程报的 Node 版本。 */
  nodeVersion: string
  close: () => Promise<void>
}

async function startFakeRemote(options: { nodeVersion?: string } = {}): Promise<FakeRemote> {
  const keyPair = generateTestKeyPair()
  const commands: string[] = []
  const writes: string[] = []
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
          sftp.on('OPEN', (reqid, filename, flags) => {
            const handle = `h${handles.size}`
            handles.set(handle, filename)
            // 只有「写打开」才清空文件。读打开也清空的话,readFile 永远读到空。
            if (flags & 0x00000002) {
              writes.push(filename)
              try {
                writeFileSync(filename, '')
              } catch {
                sftp.status(reqid, 2)
                return true
              }
            }
            sftp.handle(reqid, Buffer.from(handle))
            return true
          })
          sftp.on('STAT', (reqid, target) => {
            // ssh2 的 readFile 会先 stat 一次拿文件大小,没有这个处理器就报 unsupported
            try {
              const stats = statSync(target)
              sftp.attrs(reqid, {
                mode: stats.isDirectory() ? 0o040755 : 0o100644,
                uid: 0,
                gid: 0,
                size: stats.size,
                atime: Math.floor(stats.atimeMs / 1000),
                mtime: Math.floor(stats.mtimeMs / 1000),
              })
            } catch {
              sftp.status(reqid, 2)
            }
            return true
          })
          sftp.on('READ', (reqid, handle, offset, length) => {
            const target = handles.get(handle.toString())
            if (!target) {
              sftp.status(reqid, 4)
              return true
            }
            try {
              const content = readFileSync(target)
              const slice = content.subarray(offset, offset + length)
              // 读到头要回 EOF 状态,不然客户端会一直读下去
              if (slice.length === 0) sftp.status(reqid, 1)
              else sftp.data(reqid, slice)
            } catch {
              sftp.status(reqid, 4)
            }
            return true
          })
          sftp.on('RENAME', (reqid, from, to) => {
            try {
              renameSync(from, to)
              sftp.status(reqid, 0)
            } catch {
              sftp.status(reqid, 4)
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
            // 探活已经改走隧道,远程再出现 curl 就是回退了
            stream.write('unexpected-curl\n')
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
    writes,
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
  const keyPair = generateTestKeyPair()
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

test('部署把源码放进共享目录,令牌单独放沙盒目录', { timeout: 30_000 }, async () => {
  const remote = await startFakeRemote()
  const connection = await connectTo(remote)
  let daemon: Awaited<ReturnType<typeof deployRemoteDaemon>> | undefined
  try {
    daemon = await deployRemoteDaemon({
      client: connection.client,
      sandboxId: 'test123',
      token: 'secret-token',
      remoteWorkspace: `${REMOTE_ROOT}/workspace-test123`,
      remoteRoot: REMOTE_ROOT,
      diskMb: 2048,
      logger: silentLogger,
    })

    // 源码按内容 hash 放共享目录,沙盒自己的东西单独一个目录
    assert.match(daemon.sourceDirectory, /\/grass-daemon-[0-9a-f]{16}$/)
    assert.equal(daemon.remoteDirectory, `${REMOTE_ROOT}/grass-sandbox-test123`)

    // SFTP 写的是真磁盘。daemon 源码和它的依赖都要传过去。
    const sourceRoot = toLocalPath(daemon.sourceDirectory)
    const sandboxRoot = toLocalPath(daemon.remoteDirectory)
    const daemonContent = await readFile(path.join(sourceRoot, 'src', 'sandbox', 'daemon.ts'), 'utf-8')
    // 用 fileURLToPath 而不是 url.pathname。Windows 上 pathname 是 /B:/...,
    // 去掉开头的斜杠恰好能用;Linux 上是 /home/..., 去掉就变成相对路径了。
    const localDaemonPath = fileURLToPath(new URL('../../src/sandbox/daemon.ts', import.meta.url))
    const localDaemon = await readFile(localDaemonPath, 'utf-8')
    assert.equal(daemonContent, localDaemon, '传过去的 daemon 源码要和本地一致')

    // 依赖也传了
    for (const dependency of ['world/executionWorld.ts', 'core/pathGuard.ts', 'world/localWorld.ts']) {
      const exists = await stat(path.join(sourceRoot, 'src', dependency)).then(() => true, () => false)
      assert.equal(exists, true, `${dependency} 应该传过去`)
    }

    // 完成标记最后写,内容是完整 hash。下次部署靠它判断要不要重传。
    assert.match(await readFile(path.join(sourceRoot, '.complete'), 'utf-8'), /^[0-9a-f]{64}$/)

    // 令牌单独放沙盒目录,内容对得上
    const tokenContent = await readFile(path.join(sandboxRoot, 'token'), 'utf-8')
    assert.equal(tokenContent, 'secret-token')

    // 启动命令要绑回环、指向共享目录里的源码、指定远程工作区
    const startCommand = remote.commands.find((command) => command.includes('--serve'))
    assert.ok(startCommand, '应该有启动 daemon 的命令')
    assert.match(startCommand, /--host 127\.0\.0\.1/)
    // 端口写死会抢;交给系统分配,部署再从日志里读回来
    assert.match(startCommand, /--port 0/)
    assert.ok(startCommand.includes(daemon.sourceDirectory), 'daemon 应该从共享源码目录启动')
    assert.ok(startCommand.includes(`${REMOTE_ROOT}/workspace-test123`), '应该指向配置的远程工作区')
    assert.match(startCommand, /--advertised-root '\/workspace'|--advertised-root \/workspace/)

    // 文件和目录都走 SFTP,不该有 shell 重定向
    assert.equal(
      remote.commands.some((command) => command.includes('cat >')),
      false,
      '写文件应该走 SFTP,不该用 shell 重定向',
    )

    // 令牌只走 0600 文件。进命令行的话,同机任何人 ps 一下就看到了
    assert.equal(
      remote.commands.some((command) => command.includes('secret-token')),
      false,
      '令牌不能出现在远程命令行里',
    )
    // 探活改成走隧道,远程不该再跑 curl
    assert.equal(
      remote.commands.some((command) => command.includes('curl')),
      false,
      '探活应该走隧道,不该在远程跑 curl',
    )
  } finally {
    await connection.cleanup()
    await remote.close()
    // 断言失败也要清干净:假远程写的是真磁盘,留下的目录会让下次跑去重。
    await rm(toLocalPath(REMOTE_ROOT), { recursive: true, force: true })
  }
})

test('同一份源码第二次部署不重传', { timeout: 40_000 }, async () => {
  const remote = await startFakeRemote()
  const connection = await connectTo(remote)
  let first: Awaited<ReturnType<typeof deployRemoteDaemon>> | undefined
  let second: Awaited<ReturnType<typeof deployRemoteDaemon>> | undefined
  try {
    first = await deployRemoteDaemon({
      client: connection.client,
      sandboxId: 'reuse-a',
      token: 'token-a-reuse',
      remoteWorkspace: `${REMOTE_ROOT}/workspace-reuse`,
      remoteRoot: REMOTE_ROOT,
      diskMb: 1024,
      logger: silentLogger,
    })

    // 第二个会话:源码内容没变,应该整个目录复用
    remote.writes.length = 0
    second = await deployRemoteDaemon({
      client: connection.client,
      sandboxId: 'reuse-b',
      token: 'token-b-reuse',
      remoteWorkspace: `${REMOTE_ROOT}/workspace-reuse`,
      remoteRoot: REMOTE_ROOT,
      diskMb: 1024,
      logger: silentLogger,
    })

    assert.equal(second.sourceDirectory, first.sourceDirectory, '内容一样就该是同一个目录')
    // 沙盒目录不同,互不干扰
    assert.notEqual(second.remoteDirectory, first.remoteDirectory)
    const sourceUploads = remote.writes.filter((written) => written.startsWith(first!.sourceDirectory))
    assert.deepEqual(sourceUploads, [], '源码已就绪时一个文件都不该重传')
  } finally {
    await connection.cleanup()
    await remote.close()
    await rm(toLocalPath(REMOTE_ROOT), { recursive: true, force: true })
  }
})

test('部署过程会报进度,上传阶段带计数', { timeout: 30_000 }, async () => {
  const remote = await startFakeRemote()
  const connection = await connectTo(remote)
  const events: ProvisionProgress[] = []
  let daemon: Awaited<ReturnType<typeof deployRemoteDaemon>> | undefined
  try {
    daemon = await deployRemoteDaemon({
      client: connection.client,
      sandboxId: 'progress',
      token: 'progress-token',
      remoteWorkspace: `${REMOTE_ROOT}/workspace-progress`,
      remoteRoot: REMOTE_ROOT,
      diskMb: 1024,
      onProgress: (event) => events.push(event),
      logger: silentLogger,
    })

    const phases = events.map((event) => event.phase)
    // 十几秒的等待期间,用户至少要看到卡在哪一步
    assert.ok(phases.includes('node-check'), '应该报 Node 版本检查')
    assert.ok(phases.includes('upload'), '首次部署应该报上传')
    assert.ok(phases.includes('start'), '应该报启动 daemon')

    // 上传要带 current/total,界面才能画进度
    const uploads = events.filter((event) => event.phase === 'upload')
    assert.ok(uploads.length > 0)
    assert.equal(uploads.at(-1)?.current, uploads.length)
    assert.equal(uploads.at(-1)?.total, uploads.length)
  } finally {
    await connection.cleanup()
    await remote.close()
    await rm(toLocalPath(REMOTE_ROOT), { recursive: true, force: true })
  }
})

test('清理走 stop.sh,命令行里不出现 daemon 路径', { timeout: 30_000 }, async () => {
  const remote = await startFakeRemote()
  const connection = await connectTo(remote)
  let daemon: Awaited<ReturnType<typeof deployRemoteDaemon>> | undefined
  try {
    daemon = await deployRemoteDaemon({
      client: connection.client,
      sandboxId: 'stopck',
      token: 'stop-check-token',
      remoteWorkspace: `${REMOTE_ROOT}/workspace-stopck`,
      remoteRoot: REMOTE_ROOT,
      diskMb: 1024,
      logger: silentLogger,
    })
    await daemon.stop()

    const cleanupCommands = remote.commands.filter((command) => command.includes('rm -rf'))
    assert.equal(cleanupCommands.length, 1, '清理应该只有一条命令,半路断掉不会只做一半')
    const cleanup = cleanupCommands[0]!
    // 只删沙盒目录。共享源码目录同机其他会话还在用,不能跟着删。
    assert.ok(cleanup.includes(daemon.remoteDirectory), '清理要删沙盒目录')
    assert.equal(
      cleanup.includes(daemon.sourceDirectory),
      false,
      '共享源码目录不能删',
    )
    // 关键:pkill 必须躲在脚本里。写进命令行的话,执行它的 shell
    // 自己的命令行里也有这串字符,pkill 会把 shell 一起杀掉。
    assert.equal(
      cleanup.includes('daemon.ts'),
      false,
      '清理命令行里不能出现 daemon 路径',
    )
    // 令牌不该跟着清理命令走
    assert.equal(cleanup.includes('stop-check-token'), false)

    // 脚本内容要真的带兜底,并且点号拆开避免自匹配
    const stopScript = await readFile(
      path.join(toLocalPath(daemon.remoteDirectory), 'stop.sh'),
      'utf-8',
    )
    assert.match(stopScript, /kill "\$pid"/)
    assert.match(stopScript, /pkill -f "\$dir\/src\/sandbox\/daemon\[\.\]ts"/)
  } finally {
    await connection.cleanup()
    await remote.close()
    await rm(toLocalPath(REMOTE_ROOT), { recursive: true, force: true })
  }
})

test('远程命令的输出和退出码都要拿回来', { timeout: 20_000 }, async () => {
  const remote = await startFakeRemote()
  const connection = await connectTo(remote)
  try {
    const { runRemote } = await import('../../src/sandbox/sshDeploy.ts')
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
