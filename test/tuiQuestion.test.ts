import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Container } from '@earendil-works/pi-tui'
import { Tui } from '../src/tui.ts'

// 提问输入框的测试。
// 不启动真实终端:只构造 Tui 的状态和假编辑器,验证提交输入时的路由。

type EditorHarness = {
  disableSubmit: boolean
  onSubmit?: (text: string) => void
  addToHistory: (text: string) => void
}

type TuiHarness = {
  interactive: boolean
  busy: boolean
  stopped: boolean
  streamingText: null
  streamingContent: string
  pendingAnswer: unknown
  editor: EditorHarness
  transcript: Container
  tui: { requestRender: () => void }
}

function createHarness(): { tui: Tui; state: TuiHarness; editor: EditorHarness } {
  // 绕过构造函数,避免它接管 stdin/stdout。这里只测输入路由,不测渲染。
  const tui = Object.create(Tui.prototype) as Tui
  const editor: EditorHarness = { disableSubmit: true, addToHistory: () => {} }
  const state = tui as unknown as TuiHarness
  state.interactive = true
  state.busy = false
  state.stopped = false
  state.streamingText = null
  state.streamingContent = ''
  state.pendingAnswer = null
  state.editor = editor
  state.transcript = new Container()
  state.tui = { requestRender: () => {} }
  // 默认提交处理器;具体用例可以覆盖,但必须存在,否则回答无处提交
  tui.bindSubmit(() => {})
  return { tui, state, editor }
}

test('提问时临时解锁输入框,回答后恢复忙碌状态', async () => {
  const { tui, editor } = createHarness()
  tui.setBusy(true)
  assert.equal(editor.disableSubmit, true)

  const answerPromise = tui.askUser('使用什么语言?')
  assert.equal(editor.disableSubmit, false, '提问时输入框应该可用')

  editor.onSubmit?.('TypeScript')
  assert.equal(await answerPromise, 'TypeScript')
  assert.equal(editor.disableSubmit, true, '回答后回合仍在跑,输入框应重新锁住')
})

test('提问的回答不会触发新的 agent 回合', async () => {
  const { tui, editor } = createHarness()
  let newRoundCount = 0
  tui.bindSubmit(() => { newRoundCount++ })
  tui.setBusy(true)

  const answerPromise = tui.askUser('要继续吗?')
  editor.onSubmit?.('继续')
  await answerPromise

  assert.equal(newRoundCount, 0, '回答只能回填给提问工具,不能启动新回合')
})

test('提问的回答以斜杠开头也不会执行命令', async () => {
  const { tui, editor } = createHarness()
  let newRoundCount = 0
  tui.bindSubmit(() => { newRoundCount++ })
  tui.setBusy(true)

  const answerPromise = tui.askUser('要执行哪个命令?')
  editor.onSubmit?.('/clear')

  assert.equal(await answerPromise, '/clear')
  assert.equal(newRoundCount, 0)
})

test('等待回答时 abort 会取消等待并重新锁住输入框', async () => {
  const { tui, editor } = createHarness()
  const controller = new AbortController()
  tui.setBusy(true)

  const answerPromise = tui.askUser('要继续吗?', controller.signal)
  controller.abort()

  await assert.rejects(answerPromise, /aborted/)
  assert.equal(editor.disableSubmit, true)
})

test('回合结束后输入框恢复可用', async () => {
  const { tui, editor } = createHarness()
  tui.setBusy(true)
  const answerPromise = tui.askUser('问题')
  editor.onSubmit?.('回答')
  await answerPromise

  tui.setBusy(false)
  assert.equal(editor.disableSubmit, false)
})

test('已有问题等待回答时不接受第二个问题', async () => {
  const { tui, editor } = createHarness()
  tui.setBusy(true)
  const firstAnswer = tui.askUser('第一个问题')

  await assert.rejects(tui.askUser('第二个问题'), /已有问题/)
  editor.onSubmit?.('回答')
  assert.equal(await firstAnswer, '回答')
})

test('非交互模式不会等待用户回答', async () => {
  const { tui, state } = createHarness()
  state.interactive = false
  await assert.rejects(tui.askUser('问题'), /非交互模式/)
})
