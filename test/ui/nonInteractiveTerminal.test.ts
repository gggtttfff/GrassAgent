import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canUseInteractiveTerminal } from '../../src/ui/nonInteractiveTerminal.ts'
import { NonInteractiveTerminal } from '../../src/ui/nonInteractiveTerminal.ts'

// 非交互终端的测试。
// 核心场景:stdin 不是 TTY 时(管道、CI、IDE 插件),
// 界面不能挂死,也不能把一行文本当成按键序列解析。
//
// 注意:这里不真的读进程 stdin。
// readline 接管 stdin 后会暂停输入流,同进程的其他测试就收不到事件了——
// 测试之间会互相干扰。所以只验证不依赖 stdin 的部分。

test('非 TTY 环境判定为不可交互', () => {
  // 测试进程跑在管道里,stdin 不是 TTY
  assert.equal(canUseInteractiveTerminal(), false)
})

test('非交互终端的尺寸有默认值', () => {
  const terminal = new NonInteractiveTerminal()
  assert.ok(terminal.columns > 0, '列数应有正值')
  assert.ok(terminal.rows > 0, '行数应有正值')
})

test('非交互终端不支持 Kitty 键盘协议', () => {
  // 没有协议协商,按标准终端处理
  const terminal = new NonInteractiveTerminal()
  assert.equal(terminal.kittyProtocolActive, false)
})

test('非交互终端的终端控制方法不抛错', () => {
  const terminal = new NonInteractiveTerminal()
  // 只验证不抛错——stdout 劫持在 node:test 里不方便做
  terminal.write('')
  terminal.hideCursor()
  terminal.showCursor()
  terminal.clearLine()
  terminal.clearFromCursor()
  terminal.clearScreen()
  terminal.setTitle('x')
  terminal.setProgress(true)
  terminal.moveBy(0)
})

test('非交互终端重复 stop 不会抛错', () => {
  const terminal = new NonInteractiveTerminal()
  terminal.stop()
  terminal.stop()
})

test('非交互终端的 drainInput 立即返回', async () => {
  // 没有按键缓冲区要排空,应该立刻结束而不是等超时
  const terminal = new NonInteractiveTerminal()
  const startedAt = Date.now()
  await terminal.drainInput()
  assert.ok(Date.now() - startedAt < 100, '不该等待')
})
