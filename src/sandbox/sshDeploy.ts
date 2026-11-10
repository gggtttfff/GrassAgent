// src/sandbox/sshDeploy.ts
// 把 daemon 传到远程主机并启动它。
//
// 远程只需要能跑 Node。daemon 是 TypeScript 源码,靠 Node 的
// type stripping 直接跑,不需要编译——但远程的 Node 必须是 24.3 以上。
//
// 传的是 daemon 及其依赖的源码,不是整个仓库。远程不装任何第三方依赖:
// 这套代码只用 Node 内置模块。

import type { Client } from 'ssh2'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../logger.ts'

/** daemon 及其依赖。相对本仓库根目录。 */
const DAEMON_SOURCES = [
  'src/sandbox/daemon.ts',
  'src/sandbox/lexicalPath.ts',
  'src/sandbox/protocol.ts',
  'src/sandbox/secrets.ts',
  'src/executionWorld.ts',
  'src/jsonSafety.ts',
  'src/localWorld.ts',
  'src/outputBound.ts',
  'src/pathGuard.ts',
  'src/textEdit.ts',
  'src/approvalGate.ts',
] as const

/** 远程 daemon 监听的端口。远程只绑回环,端口不对外发布。 */
export const REMOTE_DAEMON_PORT = 8765

export type RemoteDaemon = {
  /** 远程 daemon 的回环端口。隧道要转到这里。 */
  port: number
  /** 远程上的工作目录。销毁时要清掉。 */
  remoteDirectory: string
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
  await mkdirRemote(options.client, remoteDirectory, options.logger)

  // 源码先传过去。传的是目录结构,不是 tar 包——
  // tar 要远程有 tar,这里只是几个文本文件。
  const root = projectRoot()
  const client = options.client
  const logger = options.logger
  for (const relative of DAEMON_SOURCES) {
    const content = await readFile(path.join(root, relative), 'utf-8')
    const remotePath = `${remoteDirectory}/${relative}`
    await mkdirRemote(client, path.posix.dirname(remotePath), logger)
    await putFile(client, remotePath, content, logger)
  }

  // 令牌写在远程的 0600 文件里。daemon 每次调用都读它比对。
  await putFile(client, `${remoteDirectory}/token`, options.token, logger)
  await chmodRemote(client, `${remoteDirectory}/token`, 0o600, logger)

  // 远程的 Node 版本要够。type stripping 是 24.3 才默认开启的。
  const nodeVersion = await probeNodeVersion(client, logger)
  if (nodeVersion && nodeVersion < 24) {
    throw new Error(`远程 Node 版本 ${nodeVersion} 太低,daemon 需要 24.3 以上`)
  }

  const daemonPath = `${remoteDirectory}/src/sandbox/daemon.ts`
  const startCommand = [
    'nohup node',
    shellQuote(daemonPath),
    '--serve',
    '--host', '127.0.0.1',
    '--port', String(REMOTE_DAEMON_PORT),
    '--token-file', shellQuote(`${remoteDirectory}/token`),
    '--workspace', shellQuote(options.remoteWorkspace),
    '--advertised-root', '/workspace',
    '--disk-mb', String(options.diskMb),
    `> ${shellQuote(`${remoteDirectory}/daemon.log`)} 2>&1 &`,
  ].join(' ')

  await runRemote(client, startCommand, logger)
  await waitForDaemon(client, options.token, logger)

  return {
    port: REMOTE_DAEMON_PORT,
    remoteDirectory,
    stop: async () => {
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
 * 等远程 daemon 起来。
 *
 * 用 health 调用探活,不用 sleep 猜时间。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function waitForDaemon(
  client: Client,
  token: string,
  logger?: Logger,
): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError = ''
  while (Date.now() < deadline) {
    const output = await runRemote(
      client,
      [
        `curl -sS -m 5 -X POST http://127.0.0.1:${REMOTE_DAEMON_PORT}/call`,
        `-H 'content-type: application/json'`,
        `-H 'authorization: Bearer ${token}'`,
        `--data '{"version":1,"kind":"health"}'`,
      ].join(' '),
      logger,
    )
    if (output.includes('"ok":true')) return
    lastError = output.trim()
    await delay(500)
  }
  throw new Error(`远程 daemon 没起来: ${lastError || '探活超时'}`)
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
 * 在远程建目录。目录已存在不算错。
 *
 * 走 SFTP 的 mkdir,不用 shell 的 `mkdir -p`——后者在远程不一定有,
 * 而且参数要过 shell 就有注入面。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function mkdirRemote(
  client: Client,
  remotePath: string,
  logger?: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error)
        return
      }
      sftp.mkdir(remotePath, (mkdirError) => {
        sftp.end()
        // 已存在是正常情况——多层路径会重复建同一个父目录。
        if (mkdirError && !isAlreadyExists(mkdirError)) {
          reject(new Error(`远程建目录失败 ${remotePath}: ${mkdirError.message}`))
          return
        }
        logger?.debug({ remotePath }, '远程目录已就绪')
        resolve()
      })
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
 * 改远程文件的权限。
 *
 * 走 SFTP 的 chmod,不用 shell。SFTP 的权限位只在 POSIX 远程上有意义,
 * Windows 上会被忽略——那没关系,Windows 没有 POSIX 权限模型。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function chmodRemote(
  client: Client,
  remotePath: string,
  mode: number,
  logger?: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error)
        return
      }
      sftp.chmod(remotePath, mode, (chmodError) => {
        sftp.end()
        if (chmodError) {
          reject(new Error(`远程 chmod 失败 ${remotePath}: ${chmodError.message}`))
          return
        }
        logger?.debug({ remotePath, mode }, '远程文件权限已设置')
        resolve()
      })
    })
  })
}

/**
 * 把一段文本写到远程文件。
 *
 * 走 SFTP 而不是 shell 重定向。shell 的 `cat > file` 要等通道关闭才收尾,
 * 而 ssh2 的服务端 Session 通道在 CHANNEL_CLOSE 时不推 EOF——
 * 靠它会一直挂着。SFTP 是独立协议,语义清楚。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function putFile(
  client: Client,
  remotePath: string,
  content: string,
  logger?: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error)
        return
      }
      sftp.writeFile(remotePath, content, (writeError) => {
        sftp.end()
        if (writeError) {
          reject(new Error(`写远程文件失败 ${remotePath}: ${writeError.message}`))
          return
        }
        logger?.debug({ remotePath, byteLength: Buffer.byteLength(content) }, '远程文件已写入')
        resolve()
      })
    })
  })
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
