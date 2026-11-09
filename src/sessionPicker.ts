// src/sessionPicker.ts
// 会话选择器 —— 一个弹窗,列出所有会话让用户挑。
//
// 用 pi-tui 的 SelectList + overlay:
// SelectList 处理上下移动、回车选中、Esc 取消,overlay 负责定位和焦点。
//
// 弹窗内容不能直接用 Box —— Box 没有 handleInput,
// 焦点落在它身上时按键全被吞掉,列表里的 SelectList 收不到上下键。
// 所以这里用一个薄组件把输入转发给 SelectList。
//
// 非交互模式(stdin 不是 TTY)下弹窗没意义——没有键盘可以操作。
// 所以调用方要先判断能不能弹窗,不能就走纯文本列表。

import {
  SelectList,
  Text,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui'
import type { SessionDetail } from './sessionStore.ts'
import { currentSessionMarker, mutedText, overlayTitle, selectListTheme } from './theme.ts'

/** 会话选择器的选项 */
export interface SessionChoice {
  /** 会话 ID */
  id: string
  /** 显示文本 */
  label: string
  /** 补充说明(消息条数、更新时间) */
  description: string
  /** 是不是当前会话 */
  isCurrent: boolean
}

/** 弹窗的宽度(列) */
const PICKER_WIDTH = 72
// 一次最多显示多少条
const PICKER_MAX_VISIBLE = 10

// 把时间戳格式化成「3 分钟前」这样的相对时间。
// 绝对时间太长了,一行放不下。
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前`
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时前`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 30) return `${elapsedDays} 天前`
  return new Date(timestamp).toISOString().slice(0, 10)
}

/**
 * 把会话列表转成选择器的选项。
 *
 * 当前会话排在最前面——用户多半是想回到刚才那个,不是翻到最底下找。
 */
export function buildSessionChoices(
  sessions: SessionDetail[],
  currentSessionId: string,
  now: number = Date.now(),
): SessionChoice[] {
  const sorted = [...sessions].sort((first, second) => {
    // 当前会话置顶,其余按更新时间倒序
    if (first.id === currentSessionId) return -1
    if (second.id === currentSessionId) return 1
    return second.updatedAt - first.updatedAt
  })

  return sorted.map((session) => {
    const isCurrent = session.id === currentSessionId
    const marker = isCurrent ? currentSessionMarker('●') : ' '
    const relativeTime = formatRelativeTime(session.updatedAt, now)
    const messageText = session.messageCount === 1 ? '1 条消息' : `${session.messageCount} 条消息`
    const title = session.title?.trim()
    return {
      id: session.id,
      label: `${marker} ${title || session.id}`,
      description: title
        ? `${session.id} · ${messageText} · ${relativeTime}`
        : `${messageText} · ${relativeTime}`,
      isCurrent,
    }
  })
}

/**
 * 弹窗内容组件。
 *
 * 渲染时把标题、列表、提示拼起来;输入时全部转给 SelectList。
 * 焦点落在这个组件上,列表才收得到上下键和回车。
 */
class PickerContent implements Component {
  private readonly selectList: SelectList
  private readonly title: string
  private readonly hint: string

  constructor(selectList: SelectList, title: string, hint: string) {
    this.selectList = selectList
    this.title = title
    this.hint = hint
  }

  render(width: number): string[] {
    const lines: string[] = []
    lines.push(...new Text(this.title).render(width))
    lines.push(...this.selectList.render(width))
    lines.push(...new Text(mutedText(this.hint)).render(width))
    return lines
  }

  invalidate(): void {
    this.selectList.invalidate()
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data)
  }
}

/**
 * 会话选择器。
 *
 * 用法:show() 打开弹窗,用户在列表里选,选完调 onSelect。
 * 取消(Esc)时调 onCancel。
 */
export class SessionPicker {
  private readonly selectList: SelectList
  private readonly content: PickerContent
  private overlay: OverlayHandle | null = null
  private onSelectCallback: ((sessionId: string) => void) | null = null
  private onCancelCallback: (() => void) | null = null

  constructor(choices: SessionChoice[]) {
    const items: SelectItem[] = choices.map((choice) => ({
      value: choice.id,
      label: choice.label,
      description: choice.description,
    }))

    this.selectList = new SelectList(items, PICKER_MAX_VISIBLE, selectListTheme)
    this.selectList.onSelect = (item) => {
      const sessionId = item.value
      this.close()
      this.onSelectCallback?.(sessionId)
    }
    this.selectList.onCancel = () => {
      this.close()
      this.onCancelCallback?.()
    }

    this.content = new PickerContent(this.selectList, overlayTitle('选择会话'), '回车切换,Esc 取消')
  }

  /** 选中某个会话时的回调 */
  onSelect(callback: (sessionId: string) => void): void {
    this.onSelectCallback = callback
  }

  /** 取消时的回调 */
  onCancel(callback: () => void): void {
    this.onCancelCallback = callback
  }

  /** 打开弹窗 */
  show(tui: TUI): void {
    this.overlay = tui.showOverlay(this.content, {
      anchor: 'center',
      width: PICKER_WIDTH,
      minWidth: 40,
      maxHeight: '60%',
    })
  }

  /** 关掉弹窗 */
  close(): void {
    this.overlay?.hide()
    this.overlay = null
  }
}
