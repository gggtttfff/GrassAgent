// src/plugin/cloudSession.ts
// 云端会话调度。一个会话一块沙盒,循环仍在 Grass 进程里。
// ask_user 只留给面对用户的会话。云端要人决定时,把短状态交回去。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { str, obj } from '@earendil-works/pi-schema'
import type { AgentTool } from '../agent/agent.ts'
import { parseJson, stringifyJson } from '../core/jsonSafety.ts'
import { generateSessionId } from '../session/sessionStore.ts'

export type CloudShortStatus = 'queued' | 'running' | 'needs_user' | 'done' | 'failed'

export type CloudSessionRecord = {
  sessionId: string
  sandboxId: string | null
  prompt: string
  status: CloudShortStatus
  summary: string
  answer?: string
}

export class CloudSandboxBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudSandboxBusyError'
  }
}

type StoreFile = { sessions: Record<string, CloudSessionRecord> }

async function readStore(directory: string): Promise<StoreFile> {
  try {
    const parsed = parseJson(await readFile(path.join(directory, 'sessions.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { sessions: {} }
    const sessions = (parsed as { sessions?: unknown }).sessions
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return { sessions: {} }
    return { sessions: sessions as Record<string, CloudSessionRecord> }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {} }
    throw error
  }
}

async function writeStore(directory: string, store: StoreFile): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'sessions.json'), stringifyJson(store), 'utf8')
}

/** 面对用户的会话只把任务记在宿主目录,不另开一块世界。作者：Pieory 创建日期：2025-07-18 */
export async function enqueueCloudSession(options: {
  directory: string
  prompt: string
  sessionId?: string
}): Promise<CloudSessionRecord> {
  const store = await readStore(options.directory)
  const sessionId = options.sessionId ?? generateSessionId()
  if (store.sessions[sessionId]) throw new CloudSandboxBusyError(`云端会话 ${sessionId} 已经存在`)
  const record: CloudSessionRecord = {
    sessionId,
    sandboxId: null,
    prompt: options.prompt,
    status: 'queued',
    summary: '',
  }
  store.sessions[sessionId] = record
  await writeStore(options.directory, store)
  return record
}

export async function readCloudSession(directory: string, sessionId: string): Promise<CloudSessionRecord | undefined> {
  const store = await readStore(directory)
  return store.sessions[sessionId]
}

/**
 * 把这块沙盒只绑给这一个会话。已被别的会话占用就拒绝,调用方必须关掉刚打开的世界。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function bindCloudSandbox(options: {
  directory: string
  sessionId: string
  sandboxId: string
  prompt?: string
}): Promise<CloudSessionRecord> {
  if (!options.sandboxId) throw new CloudSandboxBusyError('云端会话必须有自己的 sandboxId')
  const store = await readStore(options.directory)
  for (const record of Object.values(store.sessions)) {
    if (record.sandboxId !== options.sandboxId) continue
    if (record.sessionId !== options.sessionId) {
      throw new CloudSandboxBusyError(`沙盒 ${options.sandboxId} 已经属于会话 ${record.sessionId}`)
    }
  }
  const current = store.sessions[options.sessionId]
  if (current?.sandboxId && current.sandboxId !== options.sandboxId) {
    throw new CloudSandboxBusyError(`会话 ${options.sessionId} 已经绑了沙盒 ${current.sandboxId}`)
  }
  const record: CloudSessionRecord = {
    sessionId: options.sessionId,
    sandboxId: options.sandboxId,
    prompt: current?.prompt ?? options.prompt ?? '',
    status: 'running',
    summary: current?.summary ?? '',
    answer: current?.answer,
  }
  store.sessions[options.sessionId] = record
  await writeStore(options.directory, store)
  return record
}

/** 云端会话把短状态交回宿主目录,不调用 ask_user。作者：Pieory 创建日期：2025-07-18 */
export async function writeCloudHandoff(options: {
  directory: string
  sessionId: string
  sandboxId: string
  summary: string
  status: 'needs_user' | 'done' | 'failed'
}): Promise<CloudSessionRecord> {
  const store = await readStore(options.directory)
  const current = store.sessions[options.sessionId]
  if (current?.sandboxId && current.sandboxId !== options.sandboxId) {
    throw new CloudSandboxBusyError(`会话 ${options.sessionId} 的沙盒不一致`)
  }
  const record: CloudSessionRecord = {
    sessionId: options.sessionId,
    sandboxId: options.sandboxId,
    prompt: current?.prompt ?? '',
    status: options.status,
    summary: options.summary,
    answer: current?.answer,
  }
  store.sessions[options.sessionId] = record
  await writeStore(options.directory, store)
  return record
}

/**
 * 面对用户的会话来问人。云端会话不走这条。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function answerCloudHandoff(options: {
  directory: string
  sessionId: string
  ask: (question: string) => Promise<string | undefined>
}): Promise<CloudSessionRecord | undefined> {
  const current = await readCloudSession(options.directory, options.sessionId)
  if (!current || current.status !== 'needs_user') return current
  const answer = await options.ask(current.summary)
  if (answer === undefined) return current
  const store = await readStore(options.directory)
  const record = { ...current, answer, status: 'running' as const }
  store.sessions[options.sessionId] = record
  await writeStore(options.directory, store)
  return record
}

export function createHandoffTool(options: {
  directory: string
  sessionId: string
  sandboxId: string
}): AgentTool {
  return {
    name: 'handoff_user',
    description: '需要人决定时,把一段短状态交给面对用户的会话。不要自己提问。参数:summary(要人决定的事)',
    parameters: obj({
      summary: str({ description: '交给用户的短状态', minLength: 1 }),
    }),
    sequential: true,
    execute: async (args) => {
      const summary = (args as { summary?: string }).summary?.trim()
      if (!summary) return 'error: handoff_user 的 summary 不能为空'
      await writeCloudHandoff({
        directory: options.directory,
        sessionId: options.sessionId,
        sandboxId: options.sandboxId,
        summary,
        status: 'needs_user',
      })
      return '已把短状态交给面对用户的会话。不要再提问。'
    },
  }
}

/**
 * 跑一个云端会话:新会话、新沙盒、同一套文件工具由调用方准备。
 * 打开失败或沙盒被占用时关掉世界,不改绑本机。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function scheduleCloudSession<World extends { sandboxId: string | null, close: () => Promise<void> }>(options: {
  directory: string
  prompt: string
  openWorld: (sessionId: string) => Promise<World>
  run: (input: { sessionId: string, sandboxId: string, prompt: string }) => Promise<{ needsUser: boolean, summary: string }>
}): Promise<CloudSessionRecord> {
  const queued = await enqueueCloudSession({ directory: options.directory, prompt: options.prompt })
  let world: World | undefined
  try {
    world = await options.openWorld(queued.sessionId)
    if (!world.sandboxId) {
      throw new CloudSandboxBusyError('云端会话没有拿到 sandboxId,不改绑本机')
    }
    await bindCloudSandbox({
      directory: options.directory,
      sessionId: queued.sessionId,
      sandboxId: world.sandboxId,
    })
    const outcome = await options.run({
      sessionId: queued.sessionId,
      sandboxId: world.sandboxId,
      prompt: options.prompt,
    })
    return await writeCloudHandoff({
      directory: options.directory,
      sessionId: queued.sessionId,
      sandboxId: world.sandboxId,
      summary: outcome.summary,
      status: outcome.needsUser ? 'needs_user' : 'done',
    })
  } catch (error) {
    if (world?.sandboxId) {
      await writeCloudHandoff({
        directory: options.directory,
        sessionId: queued.sessionId,
        sandboxId: world.sandboxId,
        summary: (error as Error).message,
        status: 'failed',
      }).catch(() => undefined)
    }
    throw error
  } finally {
    await world?.close().catch(() => undefined)
  }
}
