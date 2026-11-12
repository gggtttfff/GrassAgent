// src/plugin/ports.ts
// 插件拿到的端口。世界端口没有 setMode、close 和 sandboxId。

import type { SessionSnapshot, SessionDetail, SessionStore } from '../session/sessionStore.ts'
import type { Message } from '../llm/messages.ts'
import { isSecretEnvName } from '../sandbox/secrets.ts'
import type {
  DirectoryEntry,
  ExecRequest,
  ExecResult,
  ExecutionWorld,
  SandboxMode,
  TextEdit,
} from '../world/executionWorld.ts'

/**
 * 文件和命令的收窄端口。mode 在每次调用时读取,不把活的 policy 对象交出去。
 * 作者：Pieory 创建日期：2025-07-18
 */
export type WorldPort = {
  readonly workspaceRoot: string
  mode(): SandboxMode
  read(filePath: string): Promise<string>
  readRaw(filePath: string): Promise<string>
  list(directoryPath: string): Promise<DirectoryEntry[]>
  write(filePath: string, content: string): Promise<string>
  edit(filePath: string, edits: readonly TextEdit[]): Promise<string>
  exec(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult>
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function createWorldPort(world: ExecutionWorld): WorldPort {
  return {
    get workspaceRoot() {
      return world.workspaceRoot
    },
    mode: () => world.policy.mode,
    read: (filePath) => world.read(filePath),
    readRaw: (filePath) => world.readRaw(filePath),
    list: (directoryPath) => world.list(directoryPath),
    write: (filePath, content) => world.write(filePath, content),
    edit: (filePath, edits) => world.edit(filePath, edits),
    exec: (request, signal) => world.exec(request, signal),
  }
}

export type SessionPort = {
  readonly sessionId: string
  load(): Message[]
  listSessionDetails(): SessionDetail[]
  sync(messages: Message[]): number
  createSession(messages: Message[]): string
  switchSession(sessionId: string, messages: Message[]): void
  exportSnapshots(sessionId?: string): SessionSnapshot[]
  importSession(session: SessionSnapshot, mode: 'merge' | 'replace'): 'imported' | 'replaced' | 'skipped'
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function createSessionPort(store: SessionStore): SessionPort {
  return {
    get sessionId() {
      return store.sessionId
    },
    load: () => store.load(),
    listSessionDetails: () => store.listSessionDetails(),
    sync: (messages) => store.sync(messages),
    createSession: (messages) => store.createSession(messages),
    switchSession: (sessionId, messages) => store.switchSession(sessionId, messages),
    exportSnapshots(sessionId) {
      if (!sessionId) return store.listSnapshots()
      const snapshot = store.readSession(sessionId)
      return snapshot ? [snapshot] : []
    },
    importSession: (session, mode) => store.importSession(session, mode),
  }
}

/**
 * 钩子命令的环境。继承当前进程的变量,但去掉名字里带密钥的项。
 * 容器用的那份白名单太窄,会把用户钩子自己的标记变量也丢掉。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function hookCommandEnv(options: {
  event: string
  sessionId: string
  cwd: string
  source?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isSecretEnvName(name)) continue
    env[name] = value
  }
  env.GRASSAGENT_HOOK_EVENT = options.event
  env.GRASSAGENT_SESSION_ID = options.sessionId
  env.GRASSAGENT_WORKSPACE = options.cwd
  return env
}
