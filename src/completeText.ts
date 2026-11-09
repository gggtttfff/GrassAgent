// src/completeText.ts
// 一次性文本补全 —— 把流式事件收成一段纯文本。
//
// 小模型的标题、压缩判断,以及审批模型的放行结论,都不需要工具,
// 也不需要把增量推到界面上。收口放在这里,避免每处自己扫一遍事件。

import type { Context } from './messages.ts'
import type { Model, StreamOptions } from './protocol.ts'
import { stream } from './llm.ts'

export interface TextCompletion {
  text: string
  /** 请求失败或被打断。调用方决定要不要用已经收到的半截文本 */
  failed: boolean
}

/**
 * 跑完一轮不带工具的补全,返回拼好的文本。
 *
 * failed 只覆盖 error 和 abort。模型正常结束但没说话时 text 为空、failed 为 false,
 * 由调用方决定这算不算失败。
 */
export async function completeText(
  model: Model,
  context: Context,
  options: StreamOptions = {},
): Promise<TextCompletion> {
  let text = ''
  for await (const event of stream(model, context, options)) {
    if (event.type === 'text_delta') {
      text += event.delta
    } else if (event.type === 'error' || (event.type === 'done' && event.stopReason === 'aborted')) {
      return { text, failed: true }
    }
  }
  return { text, failed: false }
}
