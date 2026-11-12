// src/plugin/sessionCommands.ts
// 九个斜杠命令。会话库只通过 SessionPort 碰,不把数据库句柄交出去。

import * as path from 'node:path'
import type { Logger } from '../core/logger.ts'
import { messagesArePaired, type Message } from '../llm/messages.ts'
import {
  BundleError,
  defaultBundlePath,
  parseExportArgument,
  parseImportArgument,
  readBundleFile,
  resolveBundlePath,
  writeBundleFile,
} from '../session/sessionBundle.ts'
import type { SlashCommand } from '../ui/slashCommands.ts'
import { isSandboxMode, SANDBOX_MODES, type SandboxMode } from '../world/executionWorld.ts'
import type { ModeSwitcher } from '../world/modeSwitch.ts'
import type { SessionPort } from './ports.ts'

export type SessionCommandDeps = {
  session: SessionPort
  workspace: string
  databasePath: string
  logger: Logger
  messages: () => Message[]
  replaceMessages: (messages: Message[]) => void
  clearCompaction: () => void
  clearTranscript: () => void
  instructionReport: () => string
  skillReport: () => string
  formatSkills: () => string
  reloadSkills: () => Promise<string>
  skillsEnabled: () => boolean
  mode: () => ModeSwitcher
  setBusy: (busy: boolean) => void
  interactive: () => boolean
  pickSession: (
    currentSessionId: string,
    onPick: (sessionId: string) => void,
    onCancel: () => void,
  ) => void
  notify: (message: string) => void
}

/**
 * 内置斜杠命令。同名由插件宿主拒绝,这里不再覆盖。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createSessionCommands(deps: SessionCommandDeps): SlashCommand[] {
  const switchToSession = async (targetSessionId: string): Promise<string> => {
    if (targetSessionId === deps.session.sessionId) return '已经在该会话中'
    deps.session.switchSession(targetSessionId, deps.messages())
    deps.replaceMessages(deps.session.load())
    deps.clearCompaction()
    deps.clearTranscript()
    deps.logger.info({ sessionId: targetSessionId }, '已切换会话')
    return `已切换到会话 ${targetSessionId}(${deps.messages().length} 条消息)`
  }

  return [
    {
      name: 'clear',
      description: '清空当前对话,保留会话',
      execute: async () => {
        await deps.session.sync(deps.messages())
        deps.replaceMessages([])
        deps.clearCompaction()
        deps.clearTranscript()
        return '对话已清空'
      },
    },
    {
      name: 'new',
      description: '开一个新会话',
      execute: async () => {
        const newSessionId = deps.session.createSession(deps.messages())
        deps.replaceMessages([])
        deps.clearCompaction()
        deps.clearTranscript()
        deps.logger.info({ sessionId: newSessionId }, '已创建新会话')
        return `已创建新会话 ${newSessionId}`
      },
    },
    {
      name: 'sessions',
      description: '列出所有会话',
      execute: async () => {
        const sessions = deps.session.listSessionDetails()
        if (sessions.length === 0) return '还没有任何会话'
        return sessions.map((session) => {
          const marker = session.id === deps.session.sessionId ? '*' : ' '
          return `${marker} ${session.id}  (${session.messageCount} 条消息)`
        }).join('\n')
      },
    },
    {
      name: 'resume',
      description: '切换到别的会话',
      argumentHint: '[会话ID]',
      execute: async (argument) => {
        const sessions = deps.session.listSessionDetails()
        if (sessions.length === 0) return '还没有任何会话'
        if (argument) {
          const target = sessions.find((session) => session.id === argument)
          if (!target) return `找不到会话 ${argument}`
          return switchToSession(target.id)
        }
        if (!deps.interactive()) {
          return '请指定会话 ID:' + sessions.map((session) => session.id).join(' ')
        }
        deps.pickSession(
          deps.session.sessionId,
          (sessionId) => {
            void switchToSession(sessionId).then((message) => deps.notify(message))
          },
          () => deps.notify('已取消'),
        )
        return ''
      },
    },
    {
      name: 'export',
      description: '把会话导出成可带走的文件',
      argumentHint: '[路径] [--session 会话ID]',
      execute: async (argument) => {
        const parsed = parseExportArgument(argument)
        if (parsed.error) return parsed.error
        await deps.session.sync(deps.messages())
        const filePath = parsed.filePath
          ? resolveBundlePath(parsed.filePath, deps.workspace)
          : defaultBundlePath(deps.workspace)
        if (path.resolve(filePath) === path.resolve(deps.databasePath)) {
          return '不能把导出发到会话数据库上,换一个路径'
        }
        const snapshots = deps.session.exportSnapshots(parsed.sessionId)
        if (parsed.sessionId && snapshots.length === 0) return `找不到会话 ${parsed.sessionId}`
        const unpaired = snapshots.filter((snapshot) => !messagesArePaired(snapshot.messages))
        try {
          await writeBundleFile(filePath, snapshots)
        } catch (error) {
          if (error instanceof BundleError) return `导出失败:${error.message}`
          throw error
        }
        deps.logger.info({ filePath, sessionCount: snapshots.length }, '会话已导出')
        const warning = unpaired.length > 0
          ? `\n有 ${unpaired.length} 个会话的 tool_call 配不上对,文件已写出,但导回时会被拒绝`
          : ''
        return `已导出 ${snapshots.length} 个会话到 ${filePath}${warning}`
      },
    },
    {
      name: 'import',
      description: '从文件导回会话',
      argumentHint: '<路径> [--replace]',
      execute: async (argument) => {
        const parsed = parseImportArgument(argument)
        if (parsed.error || !parsed.filePath) return parsed.error ?? 'import 需要文件路径'
        await deps.session.sync(deps.messages())
        const filePath = resolveBundlePath(parsed.filePath, deps.workspace)
        let sessions
        try {
          sessions = await readBundleFile(filePath)
        } catch (error) {
          if (error instanceof BundleError) return `导入失败:${error.message}`
          throw error
        }
        const mode = parsed.replace ? 'replace' : 'merge'
        let imported = 0
        let replaced = 0
        let skipped = 0
        let currentTouched = false
        for (const session of sessions) {
          const outcome = deps.session.importSession(session, mode)
          if (outcome === 'imported') imported += 1
          else if (outcome === 'replaced') replaced += 1
          else skipped += 1
          if (session.id === deps.session.sessionId && outcome !== 'skipped') currentTouched = true
        }
        if (currentTouched) {
          deps.replaceMessages(deps.session.load())
          deps.clearCompaction()
          deps.clearTranscript()
        }
        deps.logger.info({ filePath, imported, replaced, skipped, mode }, '会话已导入')
        return `导入完成:新增 ${imported},覆盖 ${replaced},跳过 ${skipped}`
      },
    },
    {
      name: 'instructions',
      description: '列出识别到的规则、提示词和技能',
      execute: () => `${deps.instructionReport()}\n${deps.skillReport()}`,
    },
    {
      name: 'skills',
      description: '列出技能,/skills reload 重新扫描',
      argumentHint: '[reload]',
      execute: async (argument) => {
        if (argument.trim() !== 'reload') return deps.formatSkills()
        if (!deps.skillsEnabled()) return '技能加载已关闭'
        return deps.reloadSkills()
      },
    },
    {
      name: 'mode',
      description: '查看或切换沙盒权限模式',
      argumentHint: '[read-only|workspace-write|danger-full-access]',
      execute: async (argument) => {
        const requested = argument.trim()
        const switcher = deps.mode()
        if (!requested) {
          return `当前沙盒模式:${switcher.current()}\n可用:${SANDBOX_MODES.join('、')}`
        }
        if (!isSandboxMode(requested)) {
          return `未知的模式 ${requested}。可用:${SANDBOX_MODES.join('、')}`
        }
        deps.setBusy(true)
        try {
          const result = await switcher.switchTo(requested as SandboxMode)
          return result.message
        } finally {
          deps.setBusy(false)
        }
      },
    },
  ]
}
