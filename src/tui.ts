// src/tui.ts
// 极简终端界面 —— 单行输入 + 流式输出 + Ctrl+C 打断。
// 不做 differential renderer、不做 component 树、不做 markdown 渲染。
// 这些是"终端 UI 框架"的功课，不是"手撕 agent"的灵魂。
 
import * as readline from 'readline'
 
export class Tui {
  private rl: readline.Interface | null = null
  private onPromptCb: ((text: string) => void) | null = null
  private onAbortCb: (() => void) | null = null
  private aborted = false
  private busy = false  // agent 运行中时为 true，阻止并发输入
  private closed = false
 
  /** 注册 prompt 回调 */
  onPrompt(cb: (text: string) => void): void {
    this.onPromptCb = cb
  }
 
  /** 注册 Ctrl+C 回调 */
  onAbort(cb: () => void): void {
    this.onAbortCb = cb
  }
 
  /** 调试器里 setRawMode 会抛错并让进程退出，失败就退回逐行输入。 */
  private canUseRawMode(): boolean {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return false
    try {
      process.stdin.setRawMode(false)
      return true
    } catch (error) {
      console.error(`[grassagent] 终端原始模式不可用，改为逐行输入: ${(error as Error).message}`)
      return false
    }
  }

  /** 启动 TUI，开始读输入 */
  start(): void {
    const terminal = this.canUseRawMode()
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal,
    })
    this.rl.on('close', () => {
      this.closed = true
      this.rl = null
    })
    // 调试控制台不是 TTY，监听 keypress 会触发 setRawMode 并立刻退出
    if (terminal) {
      process.stdin.on('keypress', (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
        if (this.busy && key?.ctrl && key?.name === 'c' && !this.aborted) {
          this.aborted = true
          this.onAbortCb?.()
        }
      })
    }

    this.prompt()
  }
  private prompt(): void {
    if (!this.rl || this.closed) return
    if (this.busy) return  // agent 运行中，不显示 prompt
    this.aborted = false
    this.rl.question('> ', (answer) => {
      if (this.closed || !this.rl) return
      const text = answer.trim()
      if (text) {
        this.onPromptCb?.(text)
        // 不立即递归 prompt()——等 setBusy(false) 时再调
      } else {
        this.prompt()  // 空输入：重新提示，不触发回调
      }
    })
  }
 
  /** agent 开始运行时调用，阻止新输入 */
  setBusy(busy: boolean): void {
    this.busy = busy
    if (!busy) this.prompt()  // agent 结束，恢复输入
  }
 
  /** 流式打印 assistant 文本 delta */
  printText(delta: string): void {
    process.stdout.write(delta)
  }
 
  /** 打印 tool 调用 */
  printToolCall(name: string, args: unknown): void {
    process.stdout.write(`\n[tool: ${name}] ${JSON.stringify(args)}\n`)
  }
 
  /** 打印 tool 结果 */
  printToolResult(name: string, result: string): void {
    process.stdout.write(`[result: ${name}] ${result}\n`)
  }
 
  /** 回合结束：换行 */
  printTurnEnd(): void {
    process.stdout.write('\n')
  }
 
  /** 停止 TUI，清理监听器 */
  stop(): void {
    this.closed = true
    this.rl?.close()
    this.rl = null
    process.stdin.removeAllListeners('keypress')
  }
}