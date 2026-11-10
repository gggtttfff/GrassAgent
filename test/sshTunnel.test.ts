import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { Writable } from 'node:stream'
import ssh2 from 'ssh2'
import {
  connectSsh,
  createHostVerifier,
  keyFingerprint,
  loadKnownHosts,
  openSshTunnel,
} from '../src/sandbox/sshTunnel.ts'
import { resolveSshConfig, expandHome } from '../src/sandbox/sshConfig.ts'
import { createLogger } from '../src/logger.ts'

// ssh2 是 CommonJS 包,ESM 下用默认导入拿具名导出。
const { Server, utils } = ssh2

// SSH 隧道的测试。
//
// 这里只测两件事:
// 1. 纯函数——主机密钥校验、HTTP 响应解析、配置展开。
// 2. 用 ssh2 的 server 模式起一个真的 SSH 服务,验证握手和转发确实能通。
//
// 真实的远程主机不在测试范围里。隧道能不能用,取决于对端肯不肯配合。

// 日志丢进一个空流,测试里不用看。
const silentLogger = createLogger({
  level: 'fatal',
  format: 'json',
  destination: new Writable({ write(_chunk, _encoding, callback) { callback() } }),
})

test('配置展开 ~ 前缀', () => {
  assert.equal(expandHome('~/.ssh/id_ed25519'), path.join(os.homedir(), '.ssh', 'id_ed25519'))
  assert.equal(expandHome('/abs/path'), '/abs/path')
  assert.equal(expandHome('relative/path'), 'relative/path')
})

test('SSH 配置把私钥路径展开成绝对路径', () => {
  const config = resolveSshConfig({
    host: 'example.com',
    username: 'dev',
    privateKeyPath: '~/.ssh/id_ed25519',
  })
  assert.equal(config.privateKeyPath, path.join(os.homedir(), '.ssh', 'id_ed25519'))
  assert.equal(config.port, 22)
  assert.equal(config.remoteWorkspace, '/workspace')
})

test('SSH 配置缺主机或用户时报错', () => {
  assert.throws(() => resolveSshConfig({ username: 'dev' }), /主机/)
  assert.throws(() => resolveSshConfig({ host: 'example.com' }), /用户名/)
})

test('主机密钥指纹用 SHA-256,和 OpenSSH 格式一致', () => {
  const key = Buffer.from('some-key-bytes')
  const fingerprint = keyFingerprint(key)
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/)
  // 同样的密钥算两次要一样
  assert.equal(fingerprint, keyFingerprint(key))
})

test('known_hosts 读出主机到指纹的映射', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-known-'))
  try {
    const key = Buffer.from('host-key-bytes')
    const fingerprint = keyFingerprint(key)
    const knownHostsPath = path.join(directory, 'known_hosts')
    await writeFile(
      knownHostsPath,
      `# 注释\nexample.com:22 ssh-ed25519 ${key.toString('base64')}\n`,
      'utf-8',
    )
    const known = loadKnownHosts(knownHostsPath, silentLogger)
    assert.equal(known.get('example.com:22'), fingerprint)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('known_hosts 不存在时不报错,当作第一次连接', () => {
  const known = loadKnownHosts(path.join(os.tmpdir(), 'no-such-known-hosts-file'), silentLogger)
  assert.equal(known.size, 0)
})

test('首次连接接受主机并记下指纹,指纹变了拒绝', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-hostkey-'))
  try {
    const config = resolveSshConfig({
      host: 'example.com',
      username: 'dev',
      knownHostsPath: path.join(directory, 'known_hosts'),
    })
    const key = Buffer.from('first-key')
    const verifier = createHostVerifier(config, silentLogger)

    // 第一次:没人能证明对错,接受
    assert.equal(verifier(key), true)

    // 同一把钥匙再来一次:还是接受
    assert.equal(verifier(key), true)

    // 换成另一把:必须拒绝,不然就是中间人
    assert.equal(verifier(Buffer.from('second-key')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// ---- 真 SSH 服务 ----

type TestHost = {
  port: number
  /** SSH wire format 的主机公钥。和 known_hosts 里 base64 存的是同一个东西。 */
  hostKey: Buffer
  close: () => Promise<void>
}

/**
 * 把 ssh2 的公钥字符串转成 SSH wire format。
 *
 * known_hosts 里存的就是这个格式,hostVerifier 收到的也是这个格式。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
function publicSshBlob(publicKey: string): Buffer {
  const parsed = utils.parseKey(publicKey)
  if (parsed instanceof Error) throw parsed
  return parsed.getPublicSSH()
}

/**
 * 起一个真的 SSH 服务。客户端拿这里的端口和密钥去连。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function startSshServer(options: {
  onExec?: (command: string) => string
  /** 隧道要转到的目标端口。给了就实现 tcpip 转发。 */
  tcpipTargetPort?: number
} = {}): Promise<TestHost> {
  const hostKeyPair = utils.generateKeyPairSync('ed25519')
  const sockets: Array<{ destroy: () => void }> = []
  const server = new Server({ hostKeys: [hostKeyPair.private] }, (client) => {
    // 客户端拒绝主机密钥时会发 DISCONNECT,服务端这边会抛。
    // 不挂监听器的话它会变成未处理异常,把测试进程带崩。
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') {
        ctx.accept()
        return
      }
      ctx.reject()
    })
    client.on('ready', () => {
      // 隧道的 forwardOut 在这边是 tcpip 请求。接到目标端口上,双向直通。
      client.on('tcpip', (acceptTcpip, rejectTcpip, info) => {
        const targetPort = options.tcpipTargetPort ?? info.destPort
        const channel = acceptTcpip()
        const socket = connect(targetPort, info.destIP)
        const track = (): void => { sockets.push(socket) }
        socket.on('connect', () => {
          track()
          socket.pipe(channel).pipe(socket)
        })
        socket.on('error', () => channel.destroy())
        channel.on('close', () => socket.destroy())
        channel.on('error', () => socket.destroy())
      })
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          const output = options.onExec?.(info.command) ?? ''
          stream.write(output)
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
    hostKey: publicSshBlob(hostKeyPair.public),
    close: () => new Promise<void>((resolve) => {
      // 连接还在时 close 不回调,先掐掉。
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
      setTimeout(resolve, 2000).unref?.()
    }),
  }
}

test('SSH 服务能接受公钥认证', async () => {
  const clientKeyPair = utils.generateKeyPairSync('ed25519')
  const privateKey = clientKeyPair.private

  const host = await startSshServer({ onExec: () => 'ok' })
  try {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-ssh-'))
    try {
      const keyPath = path.join(directory, 'id_ed25519')
      await writeFile(keyPath, privateKey, { encoding: 'utf-8', mode: 0o600 })
      const knownHostsPath = path.join(directory, 'known_hosts')
      await writeFile(
        knownHostsPath,
        `127.0.0.1:${host.port} ssh-ed25519 ${host.hostKey.toString('base64')}\n`,
        'utf-8',
      )

      const config = resolveSshConfig({
        host: '127.0.0.1',
        port: host.port,
        username: 'dev',
        privateKeyPath: keyPath,
        knownHostsPath,
      })
      // known_hosts 里的指纹要和主机实际的公钥对得上
      const known = loadKnownHosts(knownHostsPath, silentLogger)
      assert.equal(known.get(`127.0.0.1:${host.port}`), keyFingerprint(host.hostKey))

      // 用这份配置去连:握手成功说明隧道这条路是通的
      const client = await connectSsh(config, { logger: silentLogger })
      client.end()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    await host.close()
  }
})

test('主机密钥对不上时连接被拒', async () => {
  const clientKeyPair = utils.generateKeyPairSync('ed25519')
  const privateKey = clientKeyPair.private
  const host = await startSshServer()

  // 伪造一个 known_hosts,里面存的是另一把钥匙
  const wrongKeyPair = utils.generateKeyPairSync('ed25519')

  try {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-ssh-wrong-'))
    try {
      const keyPath = path.join(directory, 'id_ed25519')
      await writeFile(keyPath, privateKey, { encoding: 'utf-8', mode: 0o600 })
      const knownHostsPath = path.join(directory, 'known_hosts')
      await writeFile(
        knownHostsPath,
        `127.0.0.1:${host.port} ssh-ed25519 ${publicSshBlob(wrongKeyPair.public).toString('base64')}\n`,        'utf-8',
      )

      const config = resolveSshConfig({
        host: '127.0.0.1',
        port: host.port,
        username: 'dev',
        privateKeyPath: keyPath,
        knownHostsPath,
      })
      // 主机密钥对不上,握手必须失败。
      // ssh2 在 hostVerifier 拒绝时抛的是 KEY_EXCHANGE_FAILED。
      await assert.rejects(
        () => connectSsh(config, { logger: silentLogger }),
        (error: Error) => {
          assert.match(error.message, /KEY_EXCHANGE_FAILED|握手|verification/i)
          return true
        },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  } finally {
    await host.close()
  }
})

test('SSH 客户端的连接配置能带上主机校验', () => {
  const config = resolveSshConfig({ host: 'example.com', username: 'dev' })
  const verifier = createHostVerifier(config, silentLogger)
  assert.equal(typeof verifier, 'function')
  // 换成未知的钥匙会被拒
  assert.equal(verifier(Buffer.from('unknown')), true)
})

test('隧道把 HTTP 原样送到远端,不解析不改写', { timeout: 30_000 }, async () => {
  // 远端:一个只会回固定 JSON 的 HTTP 服务
  const remoteServer = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        gotPath: request.url,
        gotMethod: request.method,
        gotAuth: request.headers.authorization ?? '',
        gotBody: Buffer.concat(chunks).toString('utf-8'),
      }))
    })
  })
  await new Promise<void>((resolve) => remoteServer.listen(0, '127.0.0.1', () => resolve()))
  const remotePort = (remoteServer.address() as { port: number }).port

  const host = await startSshServer({ tcpipTargetPort: remotePort })
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-tunnel-'))
  try {
    const keyPath = path.join(directory, 'id_ed25519')
    await writeFile(keyPath, utils.generateKeyPairSync('ed25519').private, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    const config = resolveSshConfig({
      host: '127.0.0.1',
      port: host.port,
      username: 'dev',
      privateKeyPath: keyPath,
      knownHostsPath: path.join(directory, 'known_hosts'),
    })
    const client = await connectSsh(config, { logger: silentLogger })
    const tunnel = await openSshTunnel(client, {
      dstHost: '127.0.0.1',
      dstPort: remotePort,
      logger: silentLogger,
    })

    const response = await fetch(`http://127.0.0.1:${tunnel.localPort}/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tunnel-token',
      },
      body: JSON.stringify({ version: 1, kind: 'health' }),
    })
    const body = await response.json() as Record<string, unknown>

    // 路径、方法、头、体都要原样到达——隧道不该动内容
    assert.equal(response.status, 200)
    assert.equal(body.gotPath, '/call')
    assert.equal(body.gotMethod, 'POST')
    assert.equal(body.gotAuth, 'Bearer tunnel-token')
    assert.equal(body.gotBody, '{"version":1,"kind":"health"}')

    await tunnel.close()
    client.end()
  } finally {
    await new Promise<void>((resolve) => remoteServer.close(() => resolve()))
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
