// src/agent/askUser.ts
// ask_user 工具 —— 让模型在回合中停下来问用户。
//
// 工具本身不碰终端，也不碰 agent 上下文。
// 怎么把问题显示出来、怎么收回回答，由调用方注入。
// 这样工具测试不用起界面，界面也不用知道模型协议。

import { str, obj } from '@earendil-works/pi-schema'
import type { AgentTool } from './agent.ts'
import type { Logger } from '../core/logger.ts'

/** 用户对一次提问的回应 */
export type UserReply =
  | { status: 'answered'; answer: string }
  | { status: 'aborted' }
  | { status: 'unavailable' }

/**
 * 没有人能回答时回给模型的文本。
 *
 * 写明「不要再问」：agent 循环没有步数上限，模型如果反复调用 ask_user，
 * 每次都会立刻得到同样的失败，回合就停不下来。
 */
export const ASK_USER_UNAVAILABLE =
  'error: 当前没有用户可以回答。不要再调用 ask_user，按现有信息继续。'

const askUserParameters = obj({
  question: str({
    description: '要问用户的问题。一次只问一件事，说清楚在决定什么',
    minLength: 1,
  }),
})

export interface AskUserOptions {
  ask: (question: string, signal?: AbortSignal) => Promise<UserReply>
  logger?: Logger
}

/**
 * 构造 ask_user。
 *
 * sequential：它占用唯一的输入通道。和别的工具并发的话，
 * 回答那一行可能被别的提交吃掉，或者用户还在打字时别的工具已经改完文件。
 */
export function createAskUserTool(options: AskUserOptions): AgentTool {
  return {
    name: 'ask_user',
    description:
      '向用户提一个问题并等待回答。只在信息不足、或有多种做法必须由用户决定时使用。' +
      '能从文件或命令结果里查到的不要问。一次只问一个问题。' +
      '如果结果说当前没有用户可以回答，不要再次调用，按现有信息继续。',
    parameters: askUserParameters,
    sequential: true,
    execute: async (args, signal) => {
      if (signal?.aborted) return 'error:aborted'
      const question = (args as { question: string }).question.trim()
      // 空白问题问出去用户不知道要答什么，让模型重发
      if (!question) return 'error: ask_user 的 question 不能为空'

      const reply = await options.ask(question, signal)
      if (signal?.aborted || reply.status === 'aborted') return 'error:aborted'
      if (reply.status === 'unavailable') {
        // 兜底：管道已经结束或根本没有终端。记一下问的是什么，方便排查模型为什么停住。
        options.logger?.warn({ question }, '用户无法回答提问')
        return ASK_USER_UNAVAILABLE
      }
      return reply.answer
    },
  }
}
