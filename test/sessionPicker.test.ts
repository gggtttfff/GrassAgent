import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionPicker, buildSessionChoices, formatRelativeTime } from '../src/sessionPicker.ts'
import type { SessionDetail } from '../src/sessionStore.ts'

// 会话选择器的测试。
// 选的是「显示成什么样」,不涉及交互——交互由 pi-tui 的 SelectList 管。

// 造一个会话概要
function session(id: string, updatedAt: number, messageCount = 1): SessionDetail {
  return { id, updatedAt, messageCount }
}

// 拿到选择器的弹窗内容组件,能渲染也能发按键。
//
// 不在这里注册 onSelect —— 选择器只有一个回调,
// 测试里再注册一次会把前面的覆盖掉。
function captureContent(picker: SessionPicker): {
  render: (width: number) => string[]
  send: (key: string) => void
} {
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined
  const fakeTui = {
    showOverlay: (overlayComponent: { render(width: number): string[]; handleInput(data: string): void }) => {
      component = overlayComponent
      return {
        hide: () => {},
        setHidden: () => {},
        isHidden: () => false,
        focus: () => {},
        unfocus: () => {},
        isFocused: () => false,
        getBounds: () => undefined,
      }
    },
  } as unknown as Parameters<SessionPicker['show']>[0]

  picker.show(fakeTui)
  assert.ok(component, 'showOverlay 应该被调用')

  return {
    render: (width: number) => component!.render(width),
    send: (key: string) => component!.handleInput(key),
  }
}

test('formatRelativeTime 按时间差显示', () => {
  const now = 1_700_000_000_000
  assert.equal(formatRelativeTime(now - 30_000, now), '30 秒前')
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3 小时前')
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2 天前')
})

test('formatRelativeTime 超过 30 天显示日期', () => {
  const now = 1_700_000_000_000
  const old = now - 60 * 86_400_000
  assert.match(formatRelativeTime(old, now), /^\d{4}-\d{2}-\d{2}$/)
})

test('formatRelativeTime 未来时间显示 0 秒前', () => {
  const now = 1_700_000_000_000
  assert.equal(formatRelativeTime(now + 10_000, now), '0 秒前')
})

test('buildSessionChoices 把当前会话置顶', () => {
  const now = 1_700_000_000_000
  const choices = buildSessionChoices(
    [
      session('old', now - 10_000),
      session('current', now - 60_000),
      session('newest', now - 1_000),
    ],
    'current',
    now,
  )

  assert.equal(choices[0].id, 'current', '当前会话应该排最前')
  assert.equal(choices[0].isCurrent, true)
  // 其余按更新时间倒序
  assert.equal(choices[1].id, 'newest')
  assert.equal(choices[2].id, 'old')
})

test('buildSessionChoices 的说明带消息条数和时间', () => {
  const now = 1_700_000_000_000
  const choices = buildSessionChoices([session('s1', now - 60_000, 5)], 'other', now)

  assert.ok(choices[0].description.includes('5 条消息'))
  assert.ok(choices[0].description.includes('1 分钟前'))
})

test('buildSessionChoices 单条消息用单数', () => {
  const now = 1_700_000_000_000
  const choices = buildSessionChoices([session('s1', now, 1)], 'other', now)
  assert.ok(choices[0].description.includes('1 条消息'))
})

test('buildSessionChoices 标记当前会话', () => {
  const now = 1_700_000_000_000
  const choices = buildSessionChoices(
    [session('a', now), session('b', now)],
    'b',
    now,
  )

  const current = choices.find((choice) => choice.id === 'b')
  const other = choices.find((choice) => choice.id === 'a')
  assert.equal(current?.isCurrent, true)
  assert.equal(other?.isCurrent, false)
})

test('buildSessionChoices 会话列表为空时返回空数组', () => {
  assert.deepEqual(buildSessionChoices([], 'whatever'), [])
})

// 选择器的交互部分。
// 关键:弹窗内容必须把按键转发给列表——
// 用 Box 装列表的话 Box 没有 handleInput,焦点落在它身上时
// 上下键和回车全被吞掉,列表根本收不到。
//
// 按键是终端的原始序列,不是按键名:
// 下键是 ESC [ B,回车是 CR,Esc 是 ESC。

// 下键
const KEY_DOWN = '\x1b[B'
// 回车
const KEY_ENTER = '\r'
// Esc
const KEY_ESCAPE = '\x1b'

test('选择器渲染出标题、列表和提示', () => {
  const picker = new SessionPicker([
    { id: 's1', label: 's1', description: '1 条消息 · 1 分钟前', isCurrent: true },
    { id: 's2', label: 's2', description: '2 条消息 · 2 分钟前', isCurrent: false },
  ])

  const rendered = captureContent(picker).render(60)
  assert.ok(rendered.some((line) => line.includes('s1')), '应该渲染出会话 ID')
  assert.ok(rendered.some((line) => line.includes('选择会话')), '应该渲染出标题')
  assert.ok(rendered.some((line) => line.includes('回车切换')), '应该渲染出操作提示')
})

test('选择器把方向键转发给列表', () => {
  const picker = new SessionPicker([
    { id: 's1', label: 's1', description: '', isCurrent: true },
    { id: 's2', label: 's2', description: '', isCurrent: false },
  ])

  let selectedId: string | null = null
  picker.onSelect((sessionId) => { selectedId = sessionId })

  const captured = captureContent(picker)
  // 初始选中第一项,按一次下键应该移到第二项
  captured.send(KEY_DOWN)
  captured.send(KEY_ENTER)
  assert.equal(selectedId, 's2', '方向键应该能移动选中项')
})

test('选择器回车触发 onSelect', () => {
  const picker = new SessionPicker([
    { id: 's1', label: 's1', description: '', isCurrent: true },
  ])

  let selectedId: string | null = null
  picker.onSelect((sessionId) => { selectedId = sessionId })

  captureContent(picker).send(KEY_ENTER)
  assert.equal(selectedId, 's1')
})

test('选择器 Esc 触发 onCancel', () => {
  const picker = new SessionPicker([
    { id: 's1', label: 's1', description: '', isCurrent: true },
  ])

  let cancelled = false
  picker.onCancel(() => { cancelled = true })

  captureContent(picker).send(KEY_ESCAPE)
  assert.equal(cancelled, true, 'Esc 应该触发 onCancel')
})
