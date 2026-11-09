// src/sessionTitle.ts
// 会话标题 —— 小模型的职责之一。
//
// 标题只看用户这次说了什么,不走工具,也不进对话历史。
// 生成失败就保持无标题:会话列表还能用 ID,不能因为起名失败把回合弄断。

import type { Logger } from './logger.ts'
import type { Model, StreamOptions } from './protocol.ts'
import { completeText } from './completeText.ts'

/** 标题最长多少个字符。再长就放不进会话列表 */
const MAX_TITLE_LENGTH = 32

const TITLE_PROMPT =
  '根据用户的话生成一个会话标题。只输出标题本身,不超过 20 个字,不要引号、标点和解释。'

export interface SessionTitleStore {
  getTitle(): string | null
  setTitle(title: string): void
}

/**
 * 把模型输出收成能展示的标题。
 *
 * 模型常会加上引号、markdown 或换行解释。这些都不能进列表。
 * 收不出来就返回 null,调用方保持原来的无标题状态。
 */
export function normalizeTitle(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return null

  const cleaned = firstLine
    .replace(/^标题[:：]\s*/, '')
    .replace(/^["'「」《》]+|["'「」《》]+$/g, '')
    .replace(/[*#`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null

  return [...cleaned].slice(0, MAX_TITLE_LENGTH).join('')
}

/** 用小模型给这句话起标题。失败或空结果返回 null,不抛错 */
export async function generateSessionTitle(
  model: Model,
  userText: string,
  options: StreamOptions = {},
): Promise<string | null> {
  const trimmed = userText.trim()
  if (!trimmed || options.signal?.aborted) return null

  const completion = await completeText(
    model,
    {
      systemPrompt: TITLE_PROMPT,
      messages: [{ role: 'user', content: trimmed }],
    },
    options,
  )
  if (completion.failed || options.signal?.aborted) return null
  return normalizeTitle(completion.text)
}

/**
 * 会话还没有标题时,在后台起一个标题任务。
 *
 * 返回的 Promise 在写库之后才结束。调用方可以先去跑主力模型,
 * 回合结束再等它,这样起名不会挡住对话。
 * 已经有标题,或者这次没起出来,都返回 null。
 */
export function ensureSessionTitle(input: {
  store: SessionTitleStore
  model: Model
  userText: string
  signal?: AbortSignal
  transport?: StreamOptions['transport']
  logger?: Logger
}): Promise<string | null> {
  if (input.store.getTitle()) return Promise.resolve(null)

  return generateSessionTitle(input.model, input.userText, {
    signal: input.signal,
    transport: input.transport,
    logger: input.logger,
  })
    .then((title) => {
      if (!title || input.store.getTitle()) return null
      input.store.setTitle(title)
      input.logger?.info({ title, model: input.model.model }, '已生成会话标题')
      return title
    })
    .catch((error: unknown) => {
      input.logger?.warn(
        { errorMessage: (error as Error).message, model: input.model.model },
        '生成会话标题失败,保持无标题',
      )
      return null
    })
}
