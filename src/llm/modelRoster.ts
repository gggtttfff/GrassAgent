// src/modelRoster.ts
// 模型分工 —— 把一份配置展开成三个互不串岗的模型。
//
// 小模型:会话标题、以及「要不要压缩、压成什么」的判断。
// 主力模型:和用户对话、调用工具把问题解决掉。
// 审批模型:工具真正改文件或跑命令之前,决定放不放行。
//
// 没单独配置的角色继承主力模型,这样旧的单模型 .env 还能直接跑。
// 配了之后三条调用链就不会再共用同一个模型。

import type { AgentConfig } from '../config.ts'
import type { Model } from './protocol.ts'

/** 三个角色。调用方按角色取模型,不要临时改用另一个 */
export type ModelRole = 'small' | 'primary' | 'approval'

export interface ModelRoster {
  small: Model
  primary: Model
  approval: Model
}

// 审批结论很短,单独给一个上限,避免沿用主力模型的大 max_tokens 空等。
const DEFAULT_APPROVAL_MAX_TOKENS = 512

function inherit(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

/**
 * 按角色组装模型。
 *
 * apiKey / baseUrl / 模型名缺省都落到主力模型上。
 * 小模型的 maxTokens 也继承主力——摘要可能不短。
 * 审批模型缺省只用 512,够写一行决定和理由。
 */
export function buildModelRoster(config: AgentConfig): ModelRoster {
  const primary: Model = {
    apiKey: config.ApiKey,
    model: config.Model,
    baseUrl: config.BaseUrl,
    maxTokens: config.MaxTokens,
  }

  const small: Model = {
    apiKey: inherit(config.SmallApiKey, config.ApiKey),
    model: inherit(config.SmallModel, config.Model),
    baseUrl: inherit(config.SmallBaseUrl, config.BaseUrl),
    maxTokens: config.SmallMaxTokens ?? config.MaxTokens,
  }

  const approval: Model = {
    apiKey: inherit(config.ApprovalApiKey, config.ApiKey),
    model: inherit(config.ApprovalModel, config.Model),
    baseUrl: inherit(config.ApprovalBaseUrl, config.BaseUrl),
    maxTokens: config.ApprovalMaxTokens ?? DEFAULT_APPROVAL_MAX_TOKENS,
  }

  return { small, primary, approval }
}
