// src/mutationQueue.ts
// 文件变更队列 —— 把针对同一个文件的写操作串行化。
//
// 为什么需要:并行执行工具时,两个 edit 同一个文件会互相覆盖。
// edit 是"读-改-写"三步:两个并发 edit 都读到旧内容,
// 各自改完写回,后写的那个把前一个的修改冲掉了。
//
// 做法:按文件真实路径排队,同一路径的操作依次执行,不同路径照常并行。
// 借鉴 pi 的 file-mutation-queue 设计。

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

// 每个文件路径对应一条队列。key 是真实路径。
const mutationQueues = new Map<string, Promise<void>>()

// 注册时的串行队列。
// 用来保证"计算 key 并入队"这个过程本身是原子的——
// 否则两个并发调用可能算出同一个 key 但都拿到旧的 currentQueue。
let registrationQueue: Promise<void> = Promise.resolve()

// 当前执行链里已经持有的队列 key。
// 用 AsyncLocalStorage 跟踪,是为了让队列可重入:
// 工具内部自己又调 withFileMutationQueue 时,不会把自己等死。
const heldKeys = new AsyncLocalStorage<Set<string>>()

// ENOENT / ENOTDIR 表示路径不存在,这是正常情况(要创建新文件)
function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { code?: string }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// 算出队列 key:用真实路径,这样同一个文件的软链和真实路径会归到同一条队列。
// 文件不存在时退回解析后的绝对路径。
async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath)
  try {
    return await realpath(resolvedPath)
  } catch (error) {
    if (isMissingPathError(error)) return resolvedPath
    throw error
  }
}

/**
 * 串行化针对同一个文件的变更操作。不同文件仍并行。
 *
 * 可重入:当前执行链已经持有这个文件的锁时,再调一次不会死等。
 * 工具内部自己包一层队列是安全的(agent 层已经包了也不会卡住)。
 *
 * 用法:
 *   await withFileMutationQueue(filePath, async () => {
 *     // 读-改-写,期间不会有别的同文件操作插进来
 *   })
 */
export async function withFileMutationQueue<Result>(
  filePath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  // 注册阶段串行:key 的计算和入队必须是一个原子步骤。
  //
  // key 的解析要放在这个串行队列里面,不能在外面先 await。
  // 否则两个并发调用各自解析 key,完成顺序不确定,
  // 同一文件的操作可能按 [2, 1] 而不是 [1, 2] 的顺序执行——
  // 模型说"先写 A 再改 A"时顺序就错了。
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath)

    // 已经持有这个文件的锁:直接执行,不能再等自己(否则死等)
    const held = heldKeys.getStore()
    if (held?.has(key)) {
      return { key, currentQueue: undefined, chainedQueue: undefined, releaseNext: undefined }
    }

    const currentQueue = mutationQueues.get(key) ?? Promise.resolve()

    let releaseNext!: () => void
    const nextQueue = new Promise<void>((resolveQueue) => {
      releaseNext = resolveQueue
    })
    const chainedQueue = currentQueue.then(() => nextQueue)
    mutationQueues.set(key, chainedQueue)

    return { key, currentQueue, chainedQueue, releaseNext }
  })

  // 注册失败不能影响后续操作,所以吃掉错误
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  )

  const { key, currentQueue, chainedQueue, releaseNext } = await registration

  // 重入:当前执行链已经持有这个 key,直接执行
  if (!currentQueue || !chainedQueue || !releaseNext) {
    return await operation()
  }

  // 等前面的同文件操作完成
  await currentQueue
  try {
    // 记录当前持有这个 key,让嵌套调用能识别出来
    const held = heldKeys.getStore()
    return await heldKeys.run(new Set([...(held ?? []), key]), operation)
  } finally {
    // 释放下一个等待者,并在没人等时清掉队列条目,避免 Map 无限增长
    releaseNext()
    if (mutationQueues.get(key) === chainedQueue) {
      mutationQueues.delete(key)
    }
  }
}
