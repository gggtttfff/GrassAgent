// src/nonInteractiveTerminal.ts
// 非交互环境的终端实现 —— 管道输入、CI、IDE 插件调用时用。
//
// 为什么需要:
// pi-tui 的 ProcessTerminal 会接管终端原始模式,把输入当按键序列解析。
// 这在真正的终端里没问题,但 stdin 不是 TTY 时(管道、重定向、CI),
// 原始模式不可用,按键解析也不可靠——"你好\n" 会被当成一串按键而不是一行文本。
//
// 所以这里实现一个不接管终端的 Terminal:
// - 输入按行读,每行当成一次"提交"
// - 输出照常写 stdout,渲染逻辑不变
//
// Terminal 接口是 pi-tui 公开的,自己实现不算 hack。

import { createInterface } from 'node:readline'
import { stripTerminalSequences, type ProgramStatus, type Terminal } from '@earendil-works/pi-tui'
import { LineQueue } from './lineQueue.ts'

// 终端尺寸。非 TTY 时拿不到真实值,给个默认值让渲染逻辑能算宽度。
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24

export class NonInteractiveTerminal implements Terminal {
  private inputHandler?: (data: string) => void
  private lineReader: ReturnType<typeof createInterface> | null = null
  private stopped = false
  // 末尾不完整的 ANSI 序列,留到下次 write 一起处理
  private pendingSequence = ''
  // 回合进行中为 true：整行入队，不送进已经关掉提交的编辑器
  private holdLines = false
  private readonly lineQueue = new LineQueue()

  /**
   * stdin 读完(EOF)时的回调。
   *
   * 不能在这里直接退出进程——管道输入常常是"给一行就结束",
   * 但那一行触发的回合可能还没跑完。直接退出会把回合杀在半路上,
   * 工具可能执行了一半,会话也没存下来。
   *
   * 由上层决定什么时候退:回合结束、确实没活了再退。
   */
  onInputClosed?: () => void

  /**
   * 回合开始时占住后续输入。
   *
   * 必须在处理当前行的第一个 await 之前打开。
   * 晚了的话，管道里已经缓冲好的下一行会在让出事件循环时冲进编辑器。
   */
  setHoldLines(hold: boolean): void {
    this.holdLines = hold
  }

  /** 取出已经入队的一行。没有就返回 undefined，不等待。 */
  shiftLine(): string | undefined {
    return this.lineQueue.shift()
  }

  /** 取一行回答。队列空着就等到下一行、输入结束或 abort。 */
  takeLine(signal?: AbortSignal): Promise<string | null> {
    return this.lineQueue.take(signal)
  }

  get columns(): number {
    return process.stdout.columns ?? DEFAULT_COLUMNS
  }

  get rows(): number {
    return process.stdout.rows ?? DEFAULT_ROWS
  }

  // 没有 Kitty 协议协商,按标准终端处理
  get kittyProtocolActive(): boolean {
    return false
  }

  /**
   * ANSI 控制序列。
   *
   * stdout 不是 TTY 时不发——输出被重定向到文件或管道时,
   * 这些序列会变成一堆乱码。渲染层产出的内容还是要写,
   * 但控制序列(光标移动、清屏)没有意义。
   */
  private writeControl(sequence: string): void {
    if (!process.stdout.isTTY) return
    process.stdout.write(sequence)
  }

  /**
   * 写入渲染内容,去掉 ANSI 序列。
   *
   * 不能直接调 stripTerminalSequences:它按整串处理,
   * 一段内容被切成两半时,前半截末尾的半个 ANSI 序列会被当成普通字符留下。
   * 所以这里自己判断末尾是否有不完整的序列,留到下次 write 一起处理。
   */
  private writeRendered(data: string): void {
    const combined = this.pendingSequence + data
    // 末尾不完整序列的起始位置,没有则取全部
    const completeLength = this.findCompleteLength(combined)

    const complete = combined.slice(0, completeLength)
    this.pendingSequence = combined.slice(completeLength)

    if (!complete) return
    process.stdout.write(stripTerminalSequences(complete))
  }

  /**
   * 找出末尾不完整 ANSI 序列的起点。
   * 从后往前找最后一个 ESC,判断它开头的序列是否完整。
   */
  private findCompleteLength(text: string): number {
    const escapeIndex = text.lastIndexOf('\x1b')
    if (escapeIndex < 0) return text.length

    const sequence = text.slice(escapeIndex)
    // 完整序列能被 strip 掉,说明是完整的
    if (stripTerminalSequences(sequence) === '') return text.length
    // 不完整——留到下次
    return escapeIndex
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    process.stdout.on('resize', onResize)

    // 按行读。每读到一行就模拟一次"提交"——
    // 编辑器收到换行会走 onSubmit,和用户敲回车一样。
    this.lineReader = createInterface({ input: process.stdin, terminal: false })
    this.lineReader.on('line', (line) => {
      if (this.stopped) return
      // 回合进行中编辑器不接受提交。整行先留住，交给 ask_user 或下一轮输入。
      if (this.holdLines) {
        this.lineQueue.push(line)
        return
      }
      // 编辑器把输入当按键序列处理,不是当整行文本。
      // 一次发一整行的话,Editor 的 decodePrintableKey 只能取到第一个字符。
      // 所以逐字符发,回车单独发——回车是提交键,不能混在文本里。
      for (const character of line) {
        this.inputHandler?.(character)
      }
      this.inputHandler?.('\r')
    })
    this.lineReader.on('close', () => {
      // stdin 读完(EOF)时通知上层。
      // 上层负责判断能不能退——回合可能还在跑。
      this.stop()
      this.onInputClosed?.()
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    // 输入结束了还在等回答的话，必须立刻放开，否则回合不结束，进程也不退
    this.lineQueue.close()
    // 把残留的半个序列也清掉,不能留在输出里
    if (this.pendingSequence) {
      process.stdout.write(stripTerminalSequences(this.pendingSequence))
      this.pendingSequence = ''
    }
    this.lineReader?.close()
    this.lineReader = null
  }

  async drainInput(): Promise<void> {
    // 没有按键缓冲区,不用排空
  }

  write(data: string): void {
    // stdout 是 TTY 时原样写——交互模式要的就是这些控制序列
    if (process.stdout.isTTY) {
      process.stdout.write(data)
      return
    }
    this.writeRendered(data)
  }

  moveBy(lines: number): void {
    // 没有光标位置概念,直接输出换行
    if (lines > 0) process.stdout.write('\n'.repeat(lines))
  }

  hideCursor(): void {
    this.writeControl('\x1b[?25l')
  }

  showCursor(): void {
    this.writeControl('\x1b[?25h')
  }

  clearLine(): void {
    this.writeControl('\x1b[2K\r')
  }

  clearFromCursor(): void {
    this.writeControl('\x1b[J')
  }

  clearScreen(): void {
    this.writeControl('\x1b[2J\x1b[H')
  }

  setTitle(_title: string): void {
    // 非交互环境没有标题栏
  }

  setProgress(_active: boolean): void {
    // 非交互环境没有进度条
  }

  setProgramStatus(_status: ProgramStatus): void {
    // 非交互环境不报告状态
  }
}

/**
 * 判断当前环境能不能用交互式终端。
 *
 * stdin 和 stdout 都得是 TTY。stdout 不是 TTY 时(输出被重定向),
 * 交互式界面也没意义——用户看不到东西。
 */
export function canUseInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}
