// src/sandbox/sshDeploy.ts
// 把 daemon 传到远程主机并启动它。
//
// 远程只需要能跑 Node。daemon 是 TypeScript 源码,靠 Node 的
// type stripping 直接跑,不需要编译——但远程的 Node 必须是 24.3 以上。
//
// 传的是 daemon 及其依赖的源码,不是整个仓库。远程不装任何第三方依赖:
// 这套代码只用 Node 内置模块。

import type { Client, SFTPWrapper } from 'ssh2'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../core/logger.ts'
import { stringifyJson } from '../core/jsonSafety.ts'
import { SANDBOX_PROTOCOL_VERSION } from './protocol.ts'
import type { ProvisionProgress } from './backend.ts'
import {
  computeSourceHash,
  formatNodeVersion,
  homeWorkspace,
  MINIMUM_NODE_VERSION,
  nodeVersionIsSupported,
  parseNodeVersion,
  parseSandboxState,
  parseSweepListing,
  sandboxDirectory,
  SANDBOX_STATE_FILE_NAME,
  shouldRemoveOrphan,
  sourceDirectory,
  stagingDirectory,
  sweepListingCommand,
  type NodeVersion,
  type OrphanCandidate,
  type SandboxState,
} from './remoteLayout.ts'

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

/**
 * 远程的清理脚本。
 *
 * 为什么不直接在命令行里拼 `pkill -f <daemonPath>`:
 * 执行那条命令的 `bash -c` 自己的命令行里也有同样的字符串,
 * pkill 会把 shell 一起杀掉,后面的 `rm -rf` 就执行不到了——
 * 实测会留下一堆孤儿目录。
 *
 * 脚本落成文件后,执行时命令行只有 `sh <stop.sh> <dir>`。
 * 用数组拼而不是模板字符串:脚本里的 $ 不能被 TS 替换掉。
 */
const STOP_SCRIPT = [
  '#!/bin/sh',
  '# 清理这个沙盒的 daemon 和目录。$1 是沙盒目录。',
  'dir="$1"',
  'pidfile="$dir/daemon.pid"',
  '',
  '# 先按 PID 精准杀,再等它真的退出。',
  'if [ -f "$pidfile" ]; then',
  '  pid="$(cat "$pidfile" 2>/dev/null || true)"',
  '  if [ -n "$pid" ]; then',
  '    kill "$pid" 2>/dev/null || true',
  '    n=0',
  '    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 20 ]; do',
  '      sleep 0.1',
  '      n=$((n + 1))',
  '    done',
  '    kill -9 "$pid" 2>/dev/null || true',
  '  fi',
  'fi',
  '',
  '# 兜底:按路径杀。模式里的 [.] 把点号拆开,免得匹配到自己。',
  'pkill -f "$dir/src/sandbox/daemon[.]ts" 2>/dev/null || true',
  '',
  'exit 0',
  '',
].join('\n')

export type RemoteDaemon = {
  /** 远程 daemon 的回环端口。由系统分配,隧道要转到这里。 */
  port: number
  /** 这个沙盒自己的目录。令牌、PID、日志都在这,销毁时清掉。 */
  remoteDirectory: string
  /** 共享的源码目录。同一台机器上多个会话共用,销毁时不删。 */
  sourceDirectory: string
  /**
   * 读 daemon.log 的尾部。
   *
   * 健康检查是走隧道做的,那边拿不到远程日志——失败时拼进错误里,
   * 才不至于只剩一句「daemon 没起来」。
   */
  readLogTail: (maxChars?: number) => Promise<string>
  /** 只停进程,保留目录。keep 的沙盒回收时用这个,目录要留给下次挂回。 */
  stopProcess: () => Promise<void>
  /** 停进程并删掉沙盒目录。共享源码目录不动。 */
  stop: () => Promise<void>
}

export type DeployOptions = {
  client: Client
  sandboxId: string
  token: string
  /** 远程工作区的真实路径。留空则用远程的 $HOME/grass-workspace。 */
  remoteWorkspace?: string
  diskMb: number
  /** 回收时保留沙盒目录,供挂回用。 */
  keep?: boolean
  /** 远程上放 daemon 源码的根目录。默认 /tmp。 */
  remoteRoot?: string
  /** 部署进度。界面用来显示「卡在哪一步」。 */
  onProgress?: (event: ProvisionProgress) => void
  logger?: Logger
}

/**
 * 报一次进度。
 *
 * 界面回调抛异常不能把部署打断——显示失败比部署失败轻得多。
 */
function reportProgress(
  onProgress: ((event: ProvisionProgress) => void) | undefined,
  event: ProvisionProgress,
): void {
  try {
    onProgress?.(event)
  } catch {
    // 忽略:进度只是展示
  }
}

/**
 * 把 daemon 传到远程并启动。
 *
 * 远程目录按 sandboxId 分开,不同沙盒互不干扰。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function deployRemoteDaemon(options: DeployOptions): Promise<RemoteDaemon> {
  const client = options.client
  const logger = options.logger
  const remoteRoot = options.remoteRoot ?? '/tmp'

  // 1. Node 版本先探。不合格就别传文件了——传完再失败白等几十秒。
  reportProgress(options.onProgress, { phase: 'node-check', message: '检查远程 Node 版本' })
  const nodeVersion = await probeNodeVersion(client, logger)
  if (!nodeVersionIsSupported(nodeVersion)) {
    throw new Error(
      `远程 Node ${formatNodeVersion(nodeVersion)} 太低,daemon 需要 ` +
      `${formatNodeVersion(MINIMUM_NODE_VERSION)} 以上(type stripping 从那版起默认开启)`,
    )
  }

  // 2. 源码一次读进内存。hash 和上传必须用同一份快照——
  //    边读边传的话,中途改过的文件会让 hash 和实际内容对不上。
  const sources = await readDaemonSources()
  const { shortHash, fullHash } = computeSourceHash(sources)
  const sourceDir = sourceDirectory(remoteRoot, shortHash)
  const sandboxDir = sandboxDirectory(remoteRoot, options.sandboxId)
  const tokenPath = `${sandboxDir}/token`
  const logPath = `${sandboxDir}/daemon.log`
  const pidPath = `${sandboxDir}/daemon.pid`
  const stopPath = `${sandboxDir}/stop.sh`
  const workspace = options.remoteWorkspace ?? await resolveRemoteWorkspace(client, logger)

  // 3. 一条 SFTP 会话传完所有东西。
  // 每个操作单开一个会话的话,11 个文件加上建目录要握手二十多次,
  // 实测真实机器上要 40 秒。
  const remote = await openRemoteFiles(client)
  try {
    // 工作区要先有,daemon 起来时会对它做 realpath。不存在就直接失败。
    await createWorkspace(remote, workspace)
    await remote.mkdir(sandboxDir)
    await ensureSourceDirectory(remote, sourceDir, sources, fullHash, logger, options.onProgress)

    // 令牌写在远程的 0600 文件里。daemon 每次调用都读它比对。
    await remote.write(tokenPath, options.token)
    await remote.chmod(tokenPath, 0o600)

    // 清理脚本也提前放好。收尾时只执行它,不在命令行里拼 daemon 路径。
    await remote.write(stopPath, STOP_SCRIPT)

    // 4. SFTP 建得出目录不代表这个用户能写。报错要点名该改哪个配置。
    await assertWorkspaceWritable(client, workspace, logger)
    logger?.debug({ sourceDir, sandboxDir, sourceHash: shortHash }, '远程源码已就位')

    const daemonPath = `${sourceDir}/src/sandbox/daemon.ts`
    const startCommand = [
      'nohup node',
      shellQuote(daemonPath),
      '--serve',
      '--host', '127.0.0.1',
      // 端口交给系统挑。写死的话同一台机器上两个沙盒必然抢端口。
      '--port', '0',
      '--token-file', shellQuote(tokenPath),
      '--workspace', shellQuote(workspace),
      '--advertised-root', '/workspace',
      '--disk-mb', String(options.diskMb),
      `> ${shellQuote(logPath)} 2>&1 &`,
      // 记下 PID。按进程名杀容易误伤,按 PID 精准。
      `echo $! > ${shellQuote(pidPath)}`,
    ].join(' ')

    reportProgress(options.onProgress, { phase: 'start', message: '启动远程 daemon' })
    await runRemote(client, startCommand, logger)
    const port = await discoverDaemonPort(client, logPath, logger)
    const pid = await readDaemonPid(remote, pidPath)

    // state.json 是崩溃后唯一能说明「这个目录属于谁、还活不活」的东西。
    // 孤儿扫描和挂回都靠它。
    const state: SandboxState = {
      schema: 1,
      sandboxId: options.sandboxId,
      workspace,
      sourceHash: shortHash,
      sourceDirectory: sourceDir,
      port,
      pid,
      diskMb: options.diskMb,
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      keep: options.keep === true,
      createdAt: new Date().toISOString(),
    }
    const statePath = `${sandboxDir}/${SANDBOX_STATE_FILE_NAME}`
    await remote.write(statePath, stringifyJson(state))
    await remote.chmod(statePath, 0o600)

    // 探活交给调用方走隧道做——那才是请求真正要过的路。
    // 以前在这里用 curl 探,除了重复一次,还会把令牌放进远程的进程命令行,
    // 同一台机器上任何人 ps 一下就能看到。
    return {
      port,
      remoteDirectory: sandboxDir,
      sourceDirectory: sourceDir,
      readLogTail: async (maxChars = 800) => {
        const output = await runRemote(
          client,
          `cat ${shellQuote(logPath)} 2>/dev/null || true`,
          logger,
        )
        return output.slice(-maxChars)
      },
      stopProcess: async () => {
        // 只停进程。keep 的沙盒回收时用这个,目录要留给下次挂回。
        await runRemote(client, `sh ${shellQuote(stopPath)} ${shellQuote(sandboxDir)}`, logger)
          .catch((error: unknown) => {
            logger?.warn({
              sandboxDirectory: sandboxDir,
              errorMessage: (error as Error).message,
            }, '停止远程 daemon 失败')
          })
      },
      stop: async () => {
        // 杀进程和删目录放一条命令:中途断线的话至少不会只做一半。
        // 脚本自己带兜底,它失败了 `;` 后面的 rm 照样跑。
        //
        // 只删沙盒目录。共享源码目录同机其他会话还在用,
        // 删了它们下次重启就找不到 daemon 源码了。
        await runRemote(
          client,
          `sh ${shellQuote(stopPath)} ${shellQuote(sandboxDir)}; rm -rf ${shellQuote(sandboxDir)}`,
          logger,
        ).catch((error: unknown) => {
          // 连接已经断了的话这条命令根本跑不到。别把收尾卡住,
          // 残留目录交给下次启动的孤儿扫描。
          logger?.warn({
            sandboxDirectory: sandboxDir,
            errorMessage: (error as Error).message,
          }, '远程清理失败,留给下次启动扫描')
        })
      },
    }
  } finally {
    remote.close()
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
 * 问远程的 Node 是什么版本。
 *
 * 读不到就报错,不当未知放过——「不确定」和「够用」是两回事,
 * 放过去的话失败会推到后面更晦涩的地方。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
async function probeNodeVersion(client: Client, logger?: Logger): Promise<NodeVersion> {
  let output: string
  try {
    output = await runRemote(client, 'node --version', logger)
  } catch (error) {
    throw new Error(
      `远程没有可用的 node: ${(error as Error).message};` +
      ` daemon 需要 ${formatNodeVersion(MINIMUM_NODE_VERSION)} 以上`,
    )
  }
  const version = parseNodeVersion(output)
  if (!version) {
    throw new Error(`无法解析远程 Node 版本: ${output.trim().slice(0, 80) || '(空输出)'}`)
  }
  return version
}

/**
 * 没配远程工作区时,用远程用户自己的 HOME。
 *
 * 不用 /workspace(通常要 root 才建得出来),也不用 /tmp
 * (systemd 的 tmpfiles 会定期清理,用户的代码跟着一起没)。
 */
async function resolveRemoteWorkspace(client: Client, logger?: Logger): Promise<string> {
  let home: string
  try {
    home = (await runRemote(client, 'printf %s "$HOME"', logger)).trim()
  } catch (error) {
    throw new Error(
      `读不到远程的 $HOME: ${(error as Error).message}。` +
      '请显式配置 GRASSAGENT_SANDBOX_SSH_WORKSPACE',
    )
  }
  if (!home.startsWith('/')) {
    throw new Error('远程没有可用的 $HOME,请显式配置 GRASSAGENT_SANDBOX_SSH_WORKSPACE')
  }
  return homeWorkspace(home)
}

/** 建工作区。失败要点名该改哪个配置,而不是把 SFTP 的原始错误甩给用户。 */
async function createWorkspace(remote: RemoteFiles, workspace: string): Promise<void> {
  try {
    await remote.mkdir(workspace)
  } catch (error) {
    throw new Error(
      `远程工作区 ${workspace} 建不出来: ${(error as Error).message}。` +
      '把 GRASSAGENT_SANDBOX_SSH_WORKSPACE 指到当前用户可写的目录',
    )
  }
}

/** 建得出不等于写得了。这一条专门挡「路径存在但没有写权限」。 */
async function assertWorkspaceWritable(
  client: Client,
  workspace: string,
  logger?: Logger,
): Promise<void> {
  try {
    await runRemote(
      client,
      `test -w ${shellQuote(workspace)} && test -x ${shellQuote(workspace)}`,
      logger,
    )
  } catch {
    throw new Error(
      `远程工作区 ${workspace} 不可写。把 GRASSAGENT_SANDBOX_SSH_WORKSPACE 指到可写目录,` +
      '不要用 /workspace 这种通常需要 root 的路径',
    )
  }
}

/** 把 daemon 和它的依赖一次读进内存。 */
async function readDaemonSources(): Promise<Map<string, string>> {
  const root = projectRoot()
  const sources = new Map<string, string>()
  for (const relative of DAEMON_SOURCES) {
    sources.set(relative, await readFile(path.join(root, relative), 'utf-8'))
  }
  return sources
}

/**
 * 保证共享源码目录里就是这份内容。
 *
 * 已经完整就一个字节都不用传——这是第二次启动能秒开的原因。
 * 没完整就先传到临时目录,写完了整体改名过去:
 * 直接往目标目录写的话,两个进程同时部署会把对方的文件覆盖成半截。
 */
async function ensureSourceDirectory(
  remote: RemoteFiles,
  sourceDir: string,
  sources: ReadonlyMap<string, string>,
  fullHash: string,
  logger?: Logger,
  onProgress?: (event: ProvisionProgress) => void,
): Promise<void> {
  const completed = await remote.read(`${sourceDir}/.complete`)
  if (completed?.trim() === fullHash) {
    reportProgress(onProgress, { phase: 'reuse-source', message: '远程源码已是最新,跳过上传' })
    logger?.debug({ sourceDir }, '远程源码已是最新,跳过上传')
    return
  }

  const staging = stagingDirectory(sourceDir, randomBytes(8).toString('hex'))
  try {
    await remote.mkdir(staging)
    const relatives = [...sources.keys()].sort()
    for (const [index, relative] of relatives.entries()) {
      const remotePath = `${staging}/${relative}`
      await remote.mkdir(path.posix.dirname(remotePath))
      await remote.write(remotePath, sources.get(relative) ?? '')
      reportProgress(onProgress, {
        phase: 'upload',
        message: `上传 daemon 源码 ${index + 1}/${relatives.length}`,
        current: index + 1,
        total: relatives.length,
      })
    }
    // .complete 最后写。它出现了就代表整个目录是完整的。
    await remote.write(`${staging}/.complete`, fullHash)
    await remote.rename(staging, sourceDir)
  } catch (error) {
    // 改名失败多半是别人抢先部署完了。只要内容一致就能直接用。
    const winner = await remote.read(`${sourceDir}/.complete`).catch(() => null)
    if (winner?.trim() === fullHash) {
      logger?.info({ sourceDir }, '另一个部署先完成,复用它传的源码')
      return
    }
    logger?.warn({ staging, sourceDir }, '上传远程源码失败,临时目录留给下次启动清理')
    throw new Error(`上传远程源码失败 ${sourceDir}: ${(error as Error).message}`)
  }
}

/** 读 daemon 的 PID。读不到就当 0,后面判断活不活自然会当它已经死了。 */
async function readDaemonPid(remote: RemoteFiles, pidPath: string): Promise<number> {
  const text = await remote.read(pidPath)
  const matched = text?.trim().match(/^\d+$/)
  return matched ? Number(matched[0]) : 0
}

export type SweepOptions = {
  client: Client
  remoteRoot: string
  /** 目录至少这么旧才考虑删。太新可能在别的进程部署中。 */
  minimumAgeMs: number
  /** keep 的目录保留这么久。 */
  keepRetentionMs: number
  onProgress?: (event: ProvisionProgress) => void
  logger?: Logger
}

/**
 * 清理上次异常退出留下的目录。
 *
 * 正常收尾时用不着它。真正的场景是进程被强杀、机器重启、
 * 或者连接中途断了——那时候沙盒目录没人删,只会越积越多。
 *
 * 判断全在 shouldRemoveOrphan 里,这里只负责采集和动手。
 */
export async function sweepOrphanDirectories(options: SweepOptions): Promise<string[]> {
  const { client, remoteRoot, logger } = options
  reportProgress(options.onProgress, { phase: 'sweep', message: '扫描远程残留目录' })
  let listing: string
  try {
    listing = await runRemote(client, sweepListingCommand(remoteRoot), logger)
  } catch (error) {
    // 扫描是锦上添花,它失败不该挡住本次部署
    logger?.warn({ errorMessage: (error as Error).message }, '扫描远程残留目录失败,跳过')
    return []
  }

  const nowMs = Date.now()
  const nowSeconds = Math.floor(nowMs / 1000)
  const removed: string[] = []
  for (const line of parseSweepListing(listing)) {
    const ageMs = Math.max(0, nowSeconds - line.modifiedSeconds) * 1000
    if (ageMs < options.minimumAgeMs) continue

    if (line.kind === 'staging') {
      // 上传残留没有归属,过阈值就是垃圾
      if (await removeRemoteDirectory(client, line.directory, logger)) {
        removed.push(line.directory)
      }
      continue
    }

    const keptAt = line.state?.keptAt ? Date.parse(line.state.keptAt) : Number.NaN
    const candidate: OrphanCandidate = {
      directory: line.directory,
      ageMs,
      // 读不到 state.json 就绝不自动删——宁可留垃圾
      stateReadable: line.state !== null,
      keep: line.state?.keep === true,
      keptAgeMs: Number.isFinite(keptAt) ? Math.max(0, nowMs - keptAt) : undefined,
      pidAlive: line.pid !== null && await pidIsAlive(client, line.pid, logger),
    }
    if (!shouldRemoveOrphan(candidate, options)) continue
    if (await removeRemoteDirectory(client, line.directory, logger)) {
      removed.push(line.directory)
    }
  }

  if (removed.length > 0) {
    logger?.info({ removed, count: removed.length }, '已清理远程残留目录')
  }
  return removed
}

/** 远程进程还活着吗。挂回时用来判断要不要重新起 daemon。 */
export async function pidIsAlive(client: Client, pid: number, logger?: Logger): Promise<boolean> {
  try {
    await runRemote(client, `kill -0 ${pid}`, logger)
    return true
  } catch {
    return false
  }
}

/** 远程路径存不存在。挂回时用来确认工作区还在。 */
export async function remotePathExists(
  client: Client,
  remotePath: string,
  logger?: Logger,
): Promise<boolean> {
  try {
    await runRemote(client, `test -e ${shellQuote(remotePath)}`, logger)
    return true
  } catch {
    return false
  }
}

/** 从远程目录里读回一个沙盒的记录。读不到任何一样都返回 null。 */
export type SandboxRecord = {
  sandboxDir: string
  token: string
  state: SandboxState
}

/**
 * 读沙盒的持久化状态和令牌。
 *
 * 缺任何一样都返回 null:少令牌就没法调用 daemon,少状态就不知道端口和 PID。
 * 宁可报「挂不回去」也不要拿半套信息去拼。
 */
export async function readSandboxRecord(options: {
  client: Client
  sandboxId: string
  remoteRoot?: string
  logger?: Logger
}): Promise<SandboxRecord | null> {
  const sandboxDir = sandboxDirectory(options.remoteRoot ?? '/tmp', options.sandboxId)
  const remote = await openRemoteFiles(options.client)
  try {
    const stateText = await remote.read(`${sandboxDir}/${SANDBOX_STATE_FILE_NAME}`)
    if (!stateText) return null
    const state = parseSandboxState(stateText)
    if (!state) return null
    const token = (await remote.read(`${sandboxDir}/token`))?.trim()
    if (!token) return null
    return { sandboxDir, token, state }
  } finally {
    remote.close()
  }
}

async function removeRemoteDirectory(
  client: Client,
  directory: string,
  logger?: Logger,
): Promise<boolean> {
  try {
    await runRemote(client, `rm -rf ${shellQuote(directory)}`, logger)
    return true
  } catch (error) {
    logger?.warn({ directory, errorMessage: (error as Error).message }, '删除远程残留目录失败')
    return false
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
  /** 读文本。文件不存在或读不了返回 null,调用方按「没有」处理。 */
  read: (remotePath: string) => Promise<string | null>
  rename: (from: string, to: string) => Promise<void>
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
    async read(remotePath: string) {
      return await sftpRead(sftp, remotePath)
    },
    async rename(from: string, to: string) {
      await sftpRename(sftp, from, to)
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
 * 读远程文本文件。读不到返回 null——调用方用「文件在不在」做判断,
 * 报错会把「还没有」和「坏掉了」混成一件事。
 */
function sftpRead(sftp: SFTPWrapper, remotePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    sftp.readFile(remotePath, (readError, data) => {
      if (readError) {
        resolve(null)
        return
      }
      resolve(data.toString('utf-8'))
    })
  })
}

/**
 * 改名。同一目录内的 rename 在 POSIX 上是原子的,
 * 部署靠它把「写了一半的临时目录」和「可用的正式目录」一次切换过去。
 */
function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (renameError) => {
      if (renameError) {
        reject(new Error(`远程改名失败 ${from} -> ${to}: ${renameError.message}`))
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
