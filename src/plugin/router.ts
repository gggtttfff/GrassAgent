// src/plugin/router.ts
// 路由会话只派任务和召回短状态。执行工具留在各自的 worker 会话上。

import { str, obj } from '@earendil-works/pi-schema'
import type { AgentTool } from '../agent/agent.ts'
import { enqueueCloudSession, readCloudSession } from './cloudSession.ts'

export const ROUTER_TOOL_NAMES = ['dispatch_worker', 'recall_worker', 'ask_user'] as const

export const EXECUTION_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit',
  'edit_batch',
  'run_bash',
  'monitor',
  'load_skill',
  'handoff_user',
] as const

/** 作者：Pieory 创建日期：2025-07-18 */
export function createRouterTools(options: { directory: string }): AgentTool[] {
  return [
    {
      name: 'dispatch_worker',
      description: '把任务派给一个新的 worker 会话。本进程不执行文件和命令。参数:prompt(要做的事)',
      parameters: obj({
        prompt: str({ description: '交给 worker 的任务', minLength: 1 }),
      }),
      sequential: true,
      execute: async (args) => {
        const prompt = (args as { prompt?: string }).prompt?.trim()
        if (!prompt) return 'error: dispatch_worker 的 prompt 不能为空'
        const record = await enqueueCloudSession({ directory: options.directory, prompt })
        return `已派给 worker 会话 ${record.sessionId}\n该会话使用自己的执行世界和沙盒,本路由进程不执行。`
      },
    },
    {
      name: 'recall_worker',
      description: '按 worker 会话 id 召回短状态。需要人决定时,用 ask_user 去问,不要自己执行。参数:session_id',
      parameters: obj({
        session_id: str({ description: 'worker 会话 id', minLength: 1 }),
      }),
      sequential: true,
      execute: async (args) => {
        const sessionId = (args as { session_id?: string }).session_id?.trim()
        if (!sessionId) return 'error: recall_worker 的 session_id 不能为空'
        const record = await readCloudSession(options.directory, sessionId)
        if (!record) return `找不到 worker 会话 ${sessionId}`
        if (record.status === 'needs_user') {
          return `worker ${record.sessionId} 需要人决定: ${record.summary}。请调用 ask_user 询问用户。`
        }
        const sandbox = record.sandboxId ?? '未绑定'
        return `worker ${record.sessionId} 沙盒 ${sandbox} 状态 ${record.status}: ${record.summary}`
      },
    },
  ]
}
