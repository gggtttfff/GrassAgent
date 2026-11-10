// src/sandbox/sshTunnel.ts
// SSH 连接和端口转发。控制面用 forwardOut 把本机回环端口的流量
// 转到远程 daemon 的回环端口,远程端口不对公网发布。
//
// 主机密钥必须校验。ssh2 默认接受任何主机密钥,那等于关掉中间人防护。

// ssh2 是 CommonJS 包。ESM 下只能用默认导入拿具名导出,
// 否则 "Named export 'Client' not found"。
import ssh2 from 'ssh2'
import type { Client as SshClient, ConnectConfig } from 'ssh2'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Logger } from '../logger.ts'
import { readPrivateKey, type SshConnectionConfig } from './sshConfig.ts'

const { Client } = ssh2

export type SshTunnel = {
  /** 本机回环地址上的端口,请求发到这里就会转到远程 daemon。 */
  localPort: number
  close: () => Promise<void>
}

/**
 * 建立一条 SSH 连接。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function connectSsh(
  config: SshConnectionConfig,
  options: { logger?: Logger } = {},
): Promise<SshClient> {
  const connectConfig: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: config.timeoutMs,
    // 主机密钥换了要立刻失败,不能默默接受新密钥。
    hostVerifier: createHostVerifier(config, options.logger),
  }
  if (config.privateKeyPath) {
    connectConfig.privateKey = await readPrivateKey(config.privateKeyPath)
    if (config.privateKeyPassphrase) {
      connectConfig.passphrase = config.privateKeyPassphrase
    }
  }

  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    // ssh2 握手失败时可能连发多个 error。用 settled 挡住,
    // 不然第二个 error 变成未处理异常,把进程带崩。
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch { /* 连接已经断了,结束失败无所谓 */ }
      reject(error)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      fail(new Error(`SSH 连接超时: ${config.host}:${config.port}`))
    }, config.timeoutMs)
    client.on('error', fail)
    client.once('ready', succeed)
    client.connect(connectConfig)
  })
  // 握手过了,后续的 error 不该再当成连接失败(隧道层的错误另有处理)。
  // 但也不能让它变成未处理异常,挂一个空的监听器。
  client.on('error', () => {})
  return client
}

/**
 * 开一条隧道:本机回环上起一个 TCP 服务,连接进来就接到远程的 dstPort。
 *
 * 做的是透明 TCP 转发,不解析内容。daemon 说的是 HTTP,
 * 中间再包一层信封它就不认识了——让字节原样过去。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function openSshTunnel(
  client: SshClient,
  options: {
    dstHost: string
    dstPort: number
    logger?: Logger
  },
): Promise<SshTunnel> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    client.forwardOut('127.0.0.1', 0, options.dstHost, options.dstPort, (error, channel) => {
      if (error) {
        options.logger?.error({
          errorMessage: error.message,
          dstPort: options.dstPort,
        }, 'SSH 隧道打不开通道')
        socket.destroy()
        return
      }
      // 双向直通。任一端关闭就把另一端也关掉,别留半条连接。
      socket.pipe(channel).pipe(socket)
      socket.on('close', () => channel.destroy())
      channel.on('close', () => socket.destroy())
      channel.on('error', (channelError: Error) => {
        options.logger?.error({
          errorMessage: channelError.message,
          dstPort: options.dstPort,
        }, 'SSH 隧道通道出错')
        socket.destroy()
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    localPort: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

/**
 * 校验主机密钥。
 *
 * known_hosts 里有这个主机就按里面的比对,不一致直接拒绝。
 * 没有就按 TOFU 记下来——第一次连的时候没人能证明对错,
 * 但之后指纹变了必须炸,不然就是中间人。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createHostVerifier(
  config: SshConnectionConfig,
  logger?: Logger,
): (key: Buffer) => boolean {
  const expected = loadKnownHosts(config.knownHostsPath, logger)
  const hostKey = `${config.host}:${config.port}`
  return (key: Buffer): boolean => {
    const fingerprint = keyFingerprint(key)
    const known = expected.get(hostKey)
    if (!known) {
      // 第一次见这个主机。记录指纹,以后变了会被拒。
      logger?.warn({ host: config.host, port: config.port, fingerprint }, '首次连接该主机,已记录主机密钥指纹')
      expected.set(hostKey, fingerprint)
      return true
    }
    if (known !== fingerprint) {
      logger?.error({
        host: config.host,
        port: config.port,
        expectedFingerprint: known,
        actualFingerprint: fingerprint,
      }, '主机密钥指纹变了,拒绝连接')
      return false
    }
    return true
  }
}

/**
 * 算主机密钥指纹。用 SHA-256,和 OpenSSH 显示的格式一致。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function keyFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/**
 * 读 known_hosts,取出「主机:端口 -> 指纹」的映射。
 *
 * 文件不存在不算错——第一次连接就是这样。只关心本机要连的那几个主机,
 * 别的条目解析不出来就跳过。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function loadKnownHosts(
  knownHostsPath: string,
  logger?: Logger,
): Map<string, string> {
  const result = new Map<string, string>()
  let content: string
  try {
    content = readFileSync(knownHostsPath, 'utf-8')
  } catch {
    return result
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = trimmed.split(/\s+/)
    // 格式:主机列表 密钥类型 密钥内容
    if (parts.length < 3) continue
    const keyType = parts[1]
    const keyBase64 = parts[2]
    if (keyType !== 'ssh-ed25519' && keyType !== 'ssh-rsa' && keyType !== 'ecdsa-sha2-nistp256') {
      continue
    }
    let key: Buffer
    try {
      key = Buffer.from(keyBase64, 'base64')
    } catch {
      continue
    }
    const fingerprint = keyFingerprint(key)
    for (const host of parts[0].split(',')) {
      result.set(host.trim(), fingerprint)
    }
  }
  logger?.debug({ knownHostsPath, hostCount: result.size }, '已读入 known_hosts')
  return result
}

/**
 * 隧道关闭时一并断开 SSH 连接。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function closeSshTunnel(tunnel: SshTunnel, client: SshClient): Promise<void> {
  await tunnel.close()
  client.end()
}
