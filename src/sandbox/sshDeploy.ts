// src/sandbox/sshDeploy.ts
// 把 daemon 传到远程主机并启动它。
//
// 远程只需要能跑 Node。daemon 是 TypeScript 源码,靠 Node 的
// type stripping 直接跑,不需要编译——但远程的 Node 必须是 24.3 以上。
//
// 传的是 daemon 及其依赖的源码,不是整个仓库。远程不装任何第三方依赖:
// 这套代码只用 Node 内置模块。

import type { Client, SFTPWrapper } from 'ssh2'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../core/logger.ts'

/** daemon 及其依赖。相对本仓库根目录。 */
const DAEMON_SOURCES = [
  'src/sandbox/daemon.ts',
  'src/sandbox/lexicalPath.ts',
  'src/sandbox/protocol.ts',
  'src/sandbox/secrets.ts',
  'src/world/executionWorld.ts',
  'src/core/jsonSafety.ts',
  'src/world/localWorld.ts',
  'src/world/outputBound.ts',
  'src/core/pathGuard.ts',
  'src/core/textEdit.ts',
  'src/world/approvalGate.ts',
] as const

export type RemoteDaemon = {
  /** 远程 daemon 的回环端口。由系统分配,隧道要转到这里。 */
  port: number
  /** 远程上的工作目录。销毁时要清掉。 */
  remoteDirectory: string
  /**
   * 读 daemon.log 的尾部。
   *
   * 健康检查是走隧道做的,那边拿不到远程日志——失败时拼进错误里,
   * 才不至于只剩一句「daemon 没起来」。
   */
  readLogTail: (maxChars?: number) => Promise<string>
  stop: () => Promise<void>
}

export type DeployOptions = {
  client: Client
  sandboxId: string
  token: string
  remoteWorkspace: string
  diskMb: number
  /** 远程上放 daemon 源码的根目录。默认 /tmp。 */
  remoteRoot?: string
  logger?: Logger
}

/**
 * 把 daemon 传到远程并启动。
 *
 * 远程目录按 sandboxId 分开,不同沙盒互不干扰。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function deployRemoteDaemon(options: DeployOptions): Promise<RemoteDaemon> {
  const remoteRoot = options.remoteRoot ?? '/tmp'
  const remoteDirectory = `${remoteRoot}/grass-${options.sandboxId}`
  const client = options.client
  const logger = options.logger

  // 整次部署只用一条 SFTP 会话。
  // 每个操作单开一个会话的话,11 个文件加上建目录要握手二十多次,
  // 实测真实机器上要 40 秒。
  const remote = await openRemoteFiles(client)
  try {
    // 工作区要先有,daemon 起来时会对它做 realpath。不存在就直接失败。
    await remote.mkdir(options.remoteWorkspace)
    await remote.mkdir(remoteDirectory)

    // 源码逐个传。传的是目录结构,不是 tar 包——
    // tar 要远程有 tar,这里只是几个文本文件。
    const root = projectRoot()
    for (const relative of DAEMON_SOURCES) {
      const content = await readFile(path.join(root, relative), 'utf-8')
      const remotePath = `${remoteDirectory}/${relative}`
      await remote.mkdir(path.posix.dirname(remotePath))
      await remote.write(remotePath, content)
    }

    // 令牌写在远程的 0600 文件里。daemon 每次调用都读它比对。
    await remote.write(`${remoteDirectory}/token`, options.token)
    await remote.chmod(`${remoteDirectory}/token`, 0o600)
  } finally {
    remote.close()
  }
  logger?.debug({ remoteDirectory, fileCount: DAEMON_SOURCES.length }, '远程源码已就位')

  // 远程的 Node 版本要够。type stripping 是 24.3 才默认开启的。
  const nodeVersion = await probeNodeVersion(client, logger)
  if (nodeVersion && nodeVersion < 24) {
    throw new Error(`远程 Node 版本 ${nodeVersion} 太低,daemon 需要 24.3 以上`)
  }

  const daemonPath = `${remoteDirectory}/src/sandbox/daemon.ts`
  const logPath = `${remoteDirectory}/daemon.log`
  const pidPath = `${remoteDirectory}/daemon.pid`
  const startCommand = [
    'nohup node',
    shellQuote(daemonPath),
    '--serve',
    '--host', '127.0.0.1',
    // 端口交给系统挑。写死的话同一台机器上两个沙盒必然抢端口。
    '--port', '0',
    '--token-file', shellQuote(`${remoteDirectory}/token`),
    '--workspace', shellQuote(options.remoteWorkspace),
    '--advertised-root', '/workspace',
    '--disk-mb', String(options.diskMb),
    `> ${shellQuote(logPath)} 2>&1 &`,
    // 记下 PID。按进程名杀容易误伤,按 PID 精准。
    `echo $! > ${shellQuote(pidPath)}`,
  ].join(' ')

  await runRemote(client, startCommand, logger)
  const port = await discoverDaemonPort(client, logPath, logger)

  // 探活交给调用方走隧道做——那才是请求真正要过的路。
  // 以前在这里用 curl 探,除了重复一次,还会把令牌放进远程的进程命令行,
  // 同一台机器上任何人 ps 一下就能看到。
  return {
    port,
    remoteDirectory,
    readLogTail: async (maxChars = 800) => {
      const output = await runRemote(
        client,
        `cat ${shellQuote(logPath)} 2>/dev/null || true`,
        logger,
      )
      return output.slice(-maxChars)
    },
    stop: async () => {
      // 先按 PID 精准杀,再按路径兜底。两条都失败也不能挡住清理。
      await runRemote(
        client,
        `if [ -f ${shellQuote(pidPath)} ]; then kill "$(cat ${shellQuote(pidPath)})" 2>/dev/null || true; fi`,
        logger,
      ).catch(() => undefined)
      await runRemote(
        client,
        `pkill -f ${shellQuote(daemonPath)} || true`,
        logger,
      ).catch(() => undefined)
      await runRemote(
        client,
        `rm -rf ${shellQuote(remoteDirectory)}`,
        logger,
      ).catch(() => undefined)
    },
  }
}

/**
 * 从 daemon 日志里读出它实际监听的端口。
 *
 * daemon 用 `--port 0` 启动时由系统分配端口,起来后会打一行
 * `daemon listening http://127.0.0.1:PORT`。读那一行就知道端口。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function discoverDaemonPort(
  client: Client,
  logPath: string,
  logger?: Logger,
): Promise<number> {
  const deadline = Date.now() + 20_000
  let lastLog = ''
  while (Date.now() < deadline) {
    const output = await runRemote(client, `cat ${shellQuote(logPath)} 2>/dev/null || true`, logger)
    lastLog = output
    const matched = output.match(/daemon listening http:\/\/127\.0\.0\.1:(\d+)/)
    if (matched) {
      const port = Number(matched[1])
      logger?.info({ port }, '远程 daemon 已监听')
      return port
    }
    // daemon 起不来会把原因写进日志,别干等到超时
    if (/Error|error:|EADDR|ENOENT|Cannot find/.test(output)) {
      throw new Error(`远程 daemon 启动失败: ${output.trim().slice(-400)}`)
    }
    await delay(300)
  }
  throw new Error(`远程 daemon 没有报出监听端口: ${lastLog.trim().slice(-400) || '(日志为空)'}`)
}

/**
 * 问远程的 Node 是什么版本。读不到就当未知,不拦。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function probeNodeVersion(client: Client, logger?: Logger): Promise<number | null> {
  try {
    const output = await runRemote(client, 'node --version', logger)
    const matched = output.trim().match(/^v(\d+)\./)
    return matched ? Number(matched[1]) : null
  } catch {
    return null
  }
}

/**
 * 在远程跑一条命令,拿回输出。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function runRemote(
  client: Client,
  command: string,
  logger?: Logger,
): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      logger?.debug({ command: command.slice(0, 120) }, '远程命令开始')
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let settled = false
      let exitCode: number | null = null
      const timer = setTimeout(() => {
        // 兜底:命令没回退出码就消失时,不能永远挂着。
        finish(exitCode ?? 0)
      }, 15_000)
      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        logger?.debug({ command: command.slice(0, 120), exitCode: code }, '远程命令结束')
        const output = Buffer.concat(stdout).toString('utf-8')
        if (code !== 0) {
          const errorOutput = Buffer.concat(stderr).toString('utf-8')
          logger?.error({ exitCode: code, command: command.slice(0, 200) }, '远程命令失败')
          reject(new Error(`远程命令失败(${code}): ${errorOutput.trim() || output.trim()}`))
          return
        }
        resolve(output)
      }
      stream.on('data', (chunk: Buffer) => stdout.push(chunk))
      stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      // exit-status 只带退出码,不带输出。收到它不代表数据已经到齐。
      stream.on('exit', (code: number) => {
        exitCode = code
      })
      // end 表示对端关了写方向。数据可能还在路上,等一拍再收尾。
      stream.on('end', () => {
        setTimeout(() => finish(exitCode ?? 0), 50)
      })
      // close 表示通道彻底关闭,数据一定已经收全。这是主要的收尾信号。
      stream.on('close', (code: number) => finish(exitCode ?? code))
      stream.on('error', (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
    })
  })
}

/**
 * 一条 SFTP 会话,部署期间反复用。
 *
 * 每个操作单开会话的话,建目录加传文件要握手二十多次,
 * 真实机器上实测慢到 40 秒。一条会话做完快得多。
 */
type RemoteFiles = {
  mkdir: (remotePath: string) => Promise<void>
  write: (remotePath: string, content: string) => Promise<void>
  chmod: (remotePath: string, mode: number) => Promise<void>
  close: () => void
}

async function openRemoteFiles(client: Client): Promise<RemoteFiles> {
  const sftp = await openSftp(client)
  // 建过的目录记下来,同一层不用反复建
  const created = new Set<string>()
  return {
    async mkdir(remotePath: string) {
      // SFTP 的 mkdir 不递归,父目录不存在会直接失败。
      // 从根往下逐级建,已经有的跳过。
      for (const level of pathLevels(remotePath)) {
        if (created.has(level)) continue
        await sftpMkdir(sftp, level)
        created.add(level)
      }
    },
    async write(remotePath: string, content: string) {
      await sftpWrite(sftp, remotePath, content)
    },
    async chmod(remotePath: string, mode: number) {
      await sftpChmod(sftp, remotePath, mode)
    },
    close() {
      sftp.end()
    },
  }
}

/**
 * 把绝对路径拆成逐级的前缀。
 *
 * /a/b/c -> ['/a', '/a/b', '/a/b/c']
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function pathLevels(absolutePath: string): string[] {
  const segments = absolutePath.split('/').filter((segment) => segment.length > 0)
  const levels: string[] = []
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    levels.push(current)
  }
  return levels
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (mkdirError) => {
      // 已存在是正常情况——逐级建的时候父目录多半已经在了。
      if (!mkdirError || isAlreadyExists(mkdirError)) {
        resolve()
        return
      }
      reject(new Error(`远程建目录失败 ${remotePath}: ${mkdirError.message}`))
    })
  })
}

/**
 * 写远程文件。
 *
 * 走 SFTP 而不是 shell 重定向。shell 的 `cat > file` 要等通道关闭才收尾,
 * 而 ssh2 的服务端 Session 通道在 CHANNEL_CLOSE 时不推 EOF——
 * 靠它会一直挂着。SFTP 是独立协议,语义清楚。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
function sftpWrite(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, content, (writeError) => {
      if (writeError) {
        reject(new Error(`写远程文件失败 ${remotePath}: ${writeError.message}`))
        return
      }
      resolve()
    })
  })
}

/**
 * 改远程文件权限。
 *
 * SFTP 的权限位只在 POSIX 远程上有意义,Windows 上会被忽略——
 * 那没关系,Windows 没有 POSIX 权限模型。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
function sftpChmod(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(remotePath, mode, (chmodError) => {
      if (chmodError) {
        reject(new Error(`远程 chmod 失败 ${remotePath}: ${chmodError.message}`))
        return
      }
      resolve()
    })
  })
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error)
        return
      }
      resolve(sftp)
    })
  })
}

/**
 * 判断报错是不是「目录已存在」。
 *
 * SFTP 协议里这是状态码 4,不同实现给的消息不一样,
 * 所以消息和状态码都看一遍。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
function isAlreadyExists(error: Error & { code?: number }): boolean {
  if (error.code === 4) return true
  return /exist|already/i.test(error.message)
}

/**
 * 给 shell 参数加引号。
 *
 * 路径里可能有空格,不加引号会被拆成两个参数。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
