// src/sandbox/sshTunnel.ts
// SSH 连接和端口转发。控制面用 forwardOut 把本机回环端口的流量
// 转到远程 daemon 的回环端口,远程端口不对公网发布。
//
// 主机密钥必须校验。ssh2 默认接受任何主机密钥,那等于关掉中间人防护。

// ssh2 是 CommonJS 包。ESM 下只能用默认导入拿具名导出,
// 否则 "Named export 'Client' not found"。
import ssh2 from 'ssh2'
import type { Client as SshClient, ConnectConfig } from 'ssh2'
import { createHash, createHmac } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { createServer, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Logger } from '../core/logger.ts'
import { readPrivateKey, SshConfigError, type SshConnectionConfig } from './sshConfig.ts'

const { Client } = ssh2

export type SshTunnel = {
  /** 本机回环地址上的端口,请求发到这里就会转到远程 daemon。 */
  localPort: number
  close: () => Promise<void>
}

/**
 * 有没有一种能用的认证方式。返回 null 表示有。
 *
 * 抽成纯函数:connectSsh 要真连上服务器才跑得起来,
 * 而「什么都没配」这种情况应该在连之前就判掉,不该等握手超时。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function missingAuthMethod(
  config: Pick<SshConnectionConfig, 'privateKeyPath' | 'agentPath' | 'password'>,
): string | null {
  if (config.privateKeyPath || config.agentPath || config.password) return null
  return 'SSH 没有可用的认证方式:配置私钥路径、启动 ssh-agent 或设置密码'
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
  // 什么都没配时 ssh2 会连着失败几轮才报一个很难懂的错误,先说清楚缺什么。
  const missingAuth = missingAuthMethod(config)
  if (missingAuth) throw new SshConfigError(missingAuth)

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
  if (config.agentPath) connectConfig.agent = config.agentPath
  if (config.password) connectConfig.password = config.password

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
 * 没有就按 TOFU 接受并写回文件——第一次连的时候没人能证明对错,
 * 但之后指纹变了必须炸,不然就是中间人。
 *
 * 写回是关键:只记在内存里的话,进程一退就忘了,下次又是 TOFU,
 * 等于永远不会因为换钥匙而拒绝。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createHostVerifier(
  config: SshConnectionConfig,
  logger?: Logger,
): (key: Buffer) => boolean {
  const known = loadKnownHosts(config.knownHostsPath, logger)
  const hostName = knownHostsHostName(config.host, config.port)
  // 本次连接里刚放行的指纹。写回失败时,同一个进程内也不至于重新 TOFU。
  const acceptedInSession = new Set<string>()

  return (key: Buffer): boolean => {
    const fingerprint = keyFingerprint(key)
    const knownFingerprints = findKnownHostFingerprints(known, config.host, config.port)

    if (knownFingerprints.has(fingerprint)) return true
    if (acceptedInSession.has(fingerprint)) return true

    // 文件里完全没有这个主机的记录,才是真正的第一次连接
    if (knownFingerprints.size === 0 && acceptedInSession.size === 0) {
      acceptedInSession.add(fingerprint)
      appendKnownHost(config.knownHostsPath, hostName, key, logger)
      logger?.warn({ host: config.host, port: config.port, fingerprint }, '首次连接该主机,已记录主机密钥指纹')
      return true
    }

    logger?.error({
      host: config.host,
      port: config.port,
      knownFingerprints: [...knownFingerprints],
      actualFingerprint: fingerprint,
    }, '主机密钥指纹变了,拒绝连接')
    return false
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
 * 主机在 known_hosts 里的写法。
 *
 * OpenSSH 的规则:22 端口写裸 host,非 22 端口写 [host]:port。
 * 一律拼 host:port 的话,非标端口永远命中不了,校验就等于没有。
 */
export function knownHostsHostName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** known_hosts 里一条明文条目。patterns 保留 ! 否定前缀,匹配时统一判断。 */
export type KnownHostsEntry = {
  patterns: string[]
  fingerprint: string
}

/** OpenSSH 的哈希主机名条目:HMAC-SHA1(salt, hostname) === hash。 */
export type HashedHostEntry = {
  salt: Buffer
  hash: Buffer
  fingerprint: string
}

export type KnownHosts = {
  entries: KnownHostsEntry[]
  hashed: HashedHostEntry[]
}

/**
 * 读 known_hosts。
 *
 * 文件不存在不算错——第一次连接就是这样。解析不出来的行跳过。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function loadKnownHosts(knownHostsPath: string, logger?: Logger): KnownHosts {
  const known: KnownHosts = { entries: [], hashed: [] }
  let content: string
  try {
    content = readFileSync(knownHostsPath, 'utf-8')
  } catch {
    return known
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // @cert-authority / @revoked 是标记行,不能当普通指纹比对
    if (trimmed.startsWith('@')) continue
    const parts = trimmed.split(/\s+/)
    // 格式:主机列表 密钥类型 密钥内容
    if (parts.length < 3) continue
    const key = decodeBase64Key(parts[2]!)
    if (!key) continue
    const fingerprint = keyFingerprint(key)
    const hostField = parts[0]!
    if (hostField.startsWith('|1|')) {
      const hashed = parseHashedHost(hostField, fingerprint)
      if (hashed) known.hashed.push(hashed)
      continue
    }
    // 同一行可以用逗号列多个主机,带 ! 的是否定
    known.entries.push({
      patterns: hostField.split(',').map((pattern) => pattern.trim()).filter(Boolean),
      fingerprint,
    })
  }
  logger?.debug({
    knownHostsPath,
    entryCount: known.entries.length,
    hashedCount: known.hashed.length,
  }, '已读入 known_hosts')
  return known
}

/**
 * 找出 known_hosts 里登记给这个主机的全部指纹。
 *
 * 返回集合而不是单个值:同一台机器常常同时有 ed25519 和 rsa 两行。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function findKnownHostFingerprints(
  known: KnownHosts,
  host: string,
  port: number,
): Set<string> {
  const candidates = hostCandidates(host, port)
  const result = new Set<string>()
  for (const entry of known.entries) {
    if (entryMatches(entry.patterns, candidates)) result.add(entry.fingerprint)
  }
  for (const entry of known.hashed) {
    if (candidates.some((candidate) => hashMatches(entry, candidate))) {
      result.add(entry.fingerprint)
    }
  }
  return result
}

/**
 * 候选主机名。
 *
 * 除了 OpenSSH 规范写法,也认旧版 Grass 写下的 host:port——
 * 那些文件是历史遗留,不兼容的话用户会莫名其妙重新 TOFU 一次。
 */
function hostCandidates(host: string, port: number): string[] {
  const canonical = knownHostsHostName(host, port)
  const legacy = `${host}:${port}`
  return canonical === legacy ? [canonical] : [canonical, legacy]
}

/** 一行里的多个模式:任一肯定模式命中、且没有否定模式命中,才算这一行匹配。 */
function entryMatches(patterns: readonly string[], candidates: readonly string[]): boolean {
  let positive = false
  for (const pattern of patterns) {
    const negative = pattern.startsWith('!')
    const body = negative ? pattern.slice(1) : pattern
    if (!candidates.some((candidate) => globMatches(body, candidate))) continue
    if (negative) return false
    positive = true
  }
  return positive
}

/** OpenSSH 的 known_hosts 支持 * 和 ? 通配。 */
function globMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === value
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(value)
}

function hashMatches(entry: HashedHostEntry, candidate: string): boolean {
  const computed = createHmac('sha1', entry.salt).update(candidate).digest()
  return computed.equals(entry.hash)
}

/** 解析 |1|salt|hash 形式。salt 和 hash 都是 base64。 */
function parseHashedHost(hostField: string, fingerprint: string): HashedHostEntry | null {
  const parts = hostField.split('|')
  // 开头的 | 会切出一个空串:['', '1', salt, hash]
  if (parts.length !== 4 || parts[1] !== '1') return null
  const salt = decodeBase64Key(parts[2]!)
  const hash = decodeBase64Key(parts[3]!)
  if (!salt || !hash) return null
  return { salt, hash, fingerprint }
}

/** 解 base64 密钥内容。空串或解不出字节就当这一行坏了。 */
function decodeBase64Key(base64: string): Buffer | null {
  if (!base64) return null
  const decoded = Buffer.from(base64, 'base64')
  return decoded.length > 0 ? decoded : null
}

/**
 * 把刚认识的主机密钥追加到 known_hosts。
 *
 * 密钥类型从 SSH wire format 头部解析——写错类型的行下次读进来照样能比指纹,
 * 但 OpenSSH 自己读那份文件时会跳过,所以宁可不写也不要写错。
 *
 * 写失败不阻断连接:只 warn,下次连接会重新 TOFU 一遍。
 */
function appendKnownHost(
  knownHostsPath: string,
  hostName: string,
  key: Buffer,
  logger?: Logger,
): void {
  const keyType = sshKeyType(key)
  if (!keyType) {
    logger?.warn({ knownHostsPath }, '主机密钥类型解析不出来,没有写回 known_hosts')
    return
  }
  const line = `${hostName} ${keyType} ${key.toString('base64')}\n`
  try {
    mkdirSync(path.dirname(knownHostsPath), { recursive: true, mode: 0o700 })
    appendFileSync(knownHostsPath, line, { encoding: 'utf-8', mode: 0o600 })
  } catch (error) {
    logger?.warn({
      knownHostsPath,
      errorMessage: (error as Error).message,
    }, '主机密钥指纹写不回 known_hosts')
  }
}

/** SSH wire format 开头是长度前缀 + 算法名。 */
function sshKeyType(key: Buffer): string | null {
  if (key.length < 4) return null
  const nameLength = key.readUInt32BE(0)
  if (nameLength < 1 || nameLength > 64 || nameLength > key.length - 4) return null
  const name = key.subarray(4, 4 + nameLength).toString('ascii')
  // 算法名是可见 ASCII,带控制字符说明拿到的根本不是密钥
  return /^[a-z0-9@.-]+$/i.test(name) ? name : null
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
