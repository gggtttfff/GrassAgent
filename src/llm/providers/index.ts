// src/llm/providers/index.ts
// 内置 provider 的注册入口。
//
// 单独成文件而不是放在 llm.ts 里:注册是有副作用的,
// 放进门面会让「绕过门面直接用 resolveProvider」的调用方拿不到内置 provider。
// 任何需要内置 provider 的地方都显式 import 这个模块。

import { registerProvider } from '../protocol.ts'
import { openAIProvider } from './openai.ts'

export { openAIProvider }

// openAI 兼容协议是兜底 provider,注册顺序不影响它和精确匹配 provider 的优先级
registerProvider(openAIProvider)
