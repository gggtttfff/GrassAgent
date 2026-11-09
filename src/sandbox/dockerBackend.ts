// src/sandbox/dockerBackend.ts
// 用系统 docker 命令创建沙盒,不引入 docker 客户端库。
// 令牌放在 0600 文件里挂进容器,不出现在 docker 的参数中。

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJson } from '../jsonSafety.ts'
import type { ProvisionRequest, RunningSandbox, SandboxBackend } from './backend.ts'
import { createProcessRunner, type CommandRunner } from './commandRunner.ts'
import { cloneRepository } from './gitClone.ts'
import { ADVERTISED_WORKSPACE } from './lexicalPath.ts'
import {
  SANDBOX_PROTOCOL_VERSION,
  scrubSecrets,
  type SandboxCall,
  type SandboxResult,
} from './protocol.ts'
import { createToken, sandboxProcessEnv, writeSecretFile } from './secrets.ts'

const DAEMON_PORT = '8765'

export type DockerBackendOptions = {
  stateDir: string
  sourceDir?: string
  runner?: CommandRunner
  env?: NodeJS.ProcessEnv
}

type SandboxMeta = {
  image: string
  cpu: number
  memoryMb: number
  diskMb: number
  keep: boolean
}

/**
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createDockerBackend(options: DockerBackendOptions): SandboxBackend {
  const runner = options.runner ?? createProcessRunner()
  const sourceDir = options.sourceDir ?? defaultSourceDir()
  const env = options.env ?? process.env
  return {
    provision: (request) => provision(options.stateDir, sourceDir, runner, env, request),
    attach: (sandboxId) => attach(options.stateDir, sourceDir, runner, env, sandboxId),
  }
}

/**
 * 容器环境文件的内容。密钥名字的变量直接丢掉。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function containerEnvLines(source: NodeJS.ProcessEnv): string {
  const filtered = sandboxProcessEnv(source)
  filtered.HOME = '/tmp'
  const lines = Object.entries(filtered)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${value}`)
  return `${lines.join('\n')}\n`
}

/**
 * docker run 的参数。测试用它确认令牌和密钥没有进 argv。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function dockerRunArguments(spec: {
  name: string
  image: string
  workspaceDir: string
  tokenFile: string
  sourceDir: string
  envFile: string
  cpu: number
  memoryMb: number
  diskMb: number
  user: string
}): string[] {
  return [
    'docker', 'run', '-d',
    '--name', spec.name,
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges',
    '--user', spec.user,
    '--network', 'none',
    '--memory', `${spec.memoryMb}m`,
    '--cpus', String(spec.cpu),
    '--pids-limit', '256',
    '-v', `${spec.workspaceDir}:/workspace`,
    '-v', `${spec.tokenFile}:/run/grass/token:ro`,
    '-v', `${spec.sourceDir}:/opt/grass-daemon/src:ro`,
    '--env-file', spec.envFile,
    spec.image,
    ...containerCommand(spec.diskMb),
  ]
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function dockerExecArguments(name: string): string[] {
  return [
    'docker', 'exec', '-i', name,
    ...daemonNodeCommand(),
    '--proxy',
    '--port', DAEMON_PORT,
    '--token-file', '/run/grass/token',
  ]
}

function daemonNodeCommand(): string[] {
  return [
    'node',
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    '/opt/grass-daemon/src/sandbox/daemon.ts',
  ]
}

function containerCommand(diskMb: number): string[] {
  return [
    ...daemonNodeCommand(),
    '--serve',
    '--host', '127.0.0.1',
    '--port', DAEMON_PORT,
    '--token-file', '/run/grass/token',
    '--workspace', ADVERTISED_WORKSPACE,
    '--advertised-root', ADVERTISED_WORKSPACE,
    '--disk-mb', String(diskMb),
  ]
}

async function provision(
  stateDir: string,
  sourceDir: string,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  request: ProvisionRequest,
): Promise<RunningSandbox> {
  if (request.networkAllowlist.length > 0) {
    throw new Error('出站白名单无法在容器上装上,创建失败')
  }
  if (!request.image) throw new Error('远程沙盒缺少镜像')
  const root = sandboxRoot(stateDir, request.sandboxId)
  const workspaceDir = path.join(root, 'workspace')
  const tokenFile = path.join(root, 'token')
  const envFile = path.join(root, 'env')
  const name = containerName(request.sandboxId)
  let started = false
  try {
    await mkdir(workspaceDir, { recursive: true })
    if (containerUser() === '65534:65534') {
      const { chmod } = await import('node:fs/promises')
      await chmod(workspaceDir, 0o777)
    }
    await writeSecretFile(tokenFile, request.token)
    await writeSecretFile(envFile, containerEnvLines(env))
    await writeFile(path.join(root, 'meta.json'), JSON.stringify({
      image: request.image,
      cpu: request.cpu,
      memoryMb: request.memoryMb,
      diskMb: request.diskMb,
      keep: request.keep,
    } satisfies SandboxMeta), { encoding: 'utf-8', mode: 0o600 })
    if (request.repoUrl) {
      await cloneRepository({
        repoUrl: request.repoUrl,
        destination: workspaceDir,
        token: request.credential,
        runner,
        secretDirectory: path.join(root, 'secret'),
      })
    }
    // 同名容器可能是上次没退干净的。删掉再起,避免把旧进程当成这次的沙盒。
    await runner.run(['docker', 'rm', '-f', name])
    const run = await runner.run(dockerRunArguments({
      name,
      image: request.image,
      workspaceDir,
      tokenFile,
      sourceDir,
      envFile,
      cpu: request.cpu,
      memoryMb: request.memoryMb,
      diskMb: request.diskMb,
      user: containerUser(),
    }))
    if (run.exitCode !== 0) {
      throw new Error(`容器启动失败: ${run.stderr || run.stdout}`)
    }
    started = true
    const health = await forwardCall(runner, name, {
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'health',
    }, request.credential)
    if (!health.ok || health.version !== SANDBOX_PROTOCOL_VERSION) {
      throw new Error(`远端协议版本不符: ${health.ok ? health.version : health.error}`)
    }
    return runningFrom(runner, request.sandboxId, request.token, workspaceDir, request.keep, request.credential)
  } catch (error) {
    if (started) await runner.run(['docker', 'rm', '-f', name])
    // keep 的卷在失败时留下,下次还能挂回。没标记 keep 的半成品目录删掉。
    if (!request.keep) await rm(root, { recursive: true, force: true })
    throw new Error(scrubSecrets((error as Error).message, [request.credential ?? '', request.token]))
  }
}

async function attach(
  stateDir: string,
  sourceDir: string,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  sandboxId: string,
): Promise<RunningSandbox | null> {
  const workspaceDir = path.join(sandboxRoot(stateDir, sandboxId), 'workspace')
  try {
    await stat(workspaceDir)
  } catch {
    return null
  }
  const meta = await readMeta(sandboxRoot(stateDir, sandboxId))
  const token = createToken()
  return provision(stateDir, sourceDir, runner, env, {
    sandboxId,
    token,
    image: meta.image,
    repoUrl: '',
    credential: null,
    cpu: meta.cpu,
    memoryMb: meta.memoryMb,
    diskMb: meta.diskMb,
    networkAllowlist: [],
    keep: true,
  })
}

function runningFrom(
  runner: CommandRunner,
  sandboxId: string,
  token: string,
  localWorkspace: string,
  keep: boolean,
  credential: string | null,
): RunningSandbox {
  const name = containerName(sandboxId)
  return {
    sandboxId,
    workspaceRoot: ADVERTISED_WORKSPACE,
    token,
    localWorkspace,
    keep,
    forward: (call) => forwardCall(runner, name, call, credential),
    destroy: async ({ removeVolume }) => {
      await runner.run(['docker', 'rm', '-f', name])
      if (removeVolume) await rm(path.dirname(localWorkspace), { recursive: true, force: true })
    },
  }
}

async function forwardCall(
  runner: CommandRunner,
  name: string,
  call: SandboxCall,
  credential: string | null,
): Promise<SandboxResult> {
  let result: { exitCode: number; stdout: string; stderr: string }
  try {
    result = await runner.run(dockerExecArguments(name), { stdin: JSON.stringify(call) })
  } catch {
    return { ok: false, code: 'unavailable', error: 'sandbox unavailable' }
  }
  if (!result.stdout.trim()) {
    return {
      ok: false,
      code: 'unavailable',
      error: scrubSecrets(result.stderr || 'sandbox unavailable', [credential ?? '']),
    }
  }
  try {
    return parseJson(result.stdout) as SandboxResult
  } catch {
    return { ok: false, code: 'failed', error: 'daemon 返回的不是 JSON' }
  }
}

async function readMeta(root: string): Promise<SandboxMeta> {
  try {
    const parsed = parseJson(await readFile(path.join(root, 'meta.json'), 'utf-8'))
    if (!parsed || typeof parsed !== 'object') throw new Error('坏的元数据')
    return parsed as SandboxMeta
  } catch {
    throw new Error('沙盒元数据丢失,不能挂回')
  }
}

function sandboxRoot(stateDir: string, sandboxId: string): string {
  return path.join(stateDir, sandboxId)
}

function containerName(sandboxId: string): string {
  return `grass-${sandboxId}`
}

function containerUser(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  if (uid === 0) return '65534:65534'
  return `${uid}:${gid}`
}

function defaultSourceDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}
