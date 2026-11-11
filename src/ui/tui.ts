// src/ui/tui.ts
// 终端界面 —— 基于 @earendil-works/pi-tui。
//
// 用组件树而不是直接往 stdout 写:
// pi-tui 做差分渲染,只重画变化的行,配合 CSI 2026 同步输出做到无闪烁。
// 边流边打印时这个差别很明显——直接写 stdout 会让整屏反复重排。
//
// 结构:
//
//   TuiMainScreen
//     ├── transcript (Container)  对话记录,一直往下追加
//     └── editor     (Editor)     输入框,始终聚焦
//
// 流式输出的处理:
// Markdown 组件是整块渲染的,没法边流边排版。所以流式期间用 Text 组件
// 累积纯文本(渲染快),回合结束后换成 Markdown 组件重新排版一次。
// 用户看到的是"先出字,后成型",而不是等全部收完才突然排好版。

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
  type SlashCommand,
  type TUI,
} from '@earendil-works/pi-tui'
import { JsonSafetyError, stringifyJson } from '../core/jsonSafety.ts'
import { NonInteractiveTerminal, canUseInteractiveTerminal } from './nonInteractiveTerminal.ts'
import { SessionPicker, type SessionChoice } from './sessionPicker.ts'
import type { UserReply } from '../agent/askUser.ts'
import type { SandboxMode } from '../world/executionWorld.ts'
import {
  accentText,
  editorTheme,
  errorText,
  markdownTheme,
  mutedText,
  toolName,
  toolResult,
} from './theme.ts'

// 输入框上下留白
const EDITOR_PADDING_X = 1

// 状态行上每个模式的说法。danger 要说得直白,它是唯一会越过工作区边界的那个。
const MODE_LABELS: Record<SandboxMode, string> = {
  'read-only': 'read-only 只读',
  'workspace-write': 'workspace-write 工作区可写',
  'danger-full-access': 'danger-full-access 绕过工作区限制',
}

function formatToolArgs(args: unknown): string {
  try {
    return stringifyJson(args)
  } catch (error) {
    if (error instanceof JsonSafetyError) return '[参数嵌套过深]'
    return String(args)
  }
}

export class Tui {
  private readonly tui: TUI
  private readonly editor: Editor
  private readonly terminal: ProcessTerminal | NonInteractiveTerminal
  private readonly transcript = new Container()
  // 常驻的状态行。放在输入框上面,切模式时不用往上翻对话记录。
  private readonly modeLine = new Text('', EDITOR_PADDING_X, 0)

  private onAbortCb: (() => void) | null = null
  // 非交互模式下 stdin 读完的回调
  private onInputClosedCb: (() => void) | null = null
  // 空闲时 Ctrl+C 退出。交给 cli,这样退出前还能跑 SessionEnd 钩子。
  private onExitCb: (() => void) | null = null
  // Shift+Tab 循环模式。真正切不切由 cli 决定。
  private onModeCycleCb: (() => void) | null = null

  // 当前回合的流式文本组件。流式结束后用它换成 Markdown 组件。
  private streamingText: Text | null = null
  private streamingContent = ''

  private busy = false
  private stopped = false

  constructor() {
    // 交互式终端用 ProcessTerminal(接管原始模式,按键响应快);
    // 非交互环境(管道、CI)用逐行模式,不然"你好\n" 会被当成一串按键。
    const interactive = canUseInteractiveTerminal()
    this.terminal = interactive ? new ProcessTerminal() : new NonInteractiveTerminal()
    this.tui = new TuiMainScreen(this.terminal)
    this.editor = new Editor(this.tui, editorTheme, { paddingX: EDITOR_PADDING_X })

    // 非交互模式:stdin 读完了,但回合可能还在跑。
    // 把信号交给上层,由上层决定什么时候退。
    if (this.terminal instanceof NonInteractiveTerminal) {
      this.terminal.onInputClosed = () => this.onInputClosedCb?.()
    }

    this.tui.addChild(this.transcript)
    this.tui.addChild(this.modeLine)
    this.tui.addChild(this.editor)
    this.tui.setFocus(this.editor)

    // raw 模式下 Ctrl+C 不会触发 SIGINT,得自己拦。
    // 空闲时按 Ctrl+C 退出,运行中则打断当前回合。
    // 两种情况都要 consume 掉这个按键——不然它会落到编辑器里变成一个 ^C 字符。
    //
    // Shift+Tab 循环模式。编辑器的 tab 绑定是裸 tab,带 shift 的不会落到它手里;
    // 这个监听器又排在聚焦组件之前,所以能先拿到。
    //
    // 非交互环境不注册这个监听:那边没有原始模式,Ctrl+C 会正常触发 SIGINT,
    // 由 cli 层的 SIGINT 处理函数接管,也没有键盘能按 Shift+Tab。
    if (canUseInteractiveTerminal()) {
      this.tui.addInputListener((data) => {
        if (matchesKey(data, 'ctrl+c')) {
          if (this.busy) {
            this.onAbortCb?.()
          } else if (this.onExitCb) {
            this.onExitCb()
          } else {
            this.stop()
            process.exit(0)
          }
          return { consume: true }
        }
        if (matchesKey(data, 'shift+tab')) {
          this.onModeCycleCb?.()
          return { consume: true }
        }
        return undefined
      })
    }
  }

  /**
   * 挂上斜杠命令的自动补全。
   *
   * 用 pi-tui 自带的 CombinedAutocompleteProvider——它同时管命令名和文件路径,
   * 命令名从我们这边传进去,文件路径基于工作目录。
   *
   * 只在交互模式挂。非交互模式没有键盘,补全列表弹出来也没人选。
   */
  setSlashCommands(commands: SlashCommand[], workspace: string): void {
    if (!canUseInteractiveTerminal()) return
    const provider = new CombinedAutocompleteProvider(commands, workspace)
    this.editor.setAutocompleteProvider(provider)
  }

  /**
   * 弹出会话选择器。
   *
   * 用户选中后调 onSelect,取消后调 onCancel。
   */
  showSessionPicker(choices: SessionChoice[], onSelect: (sessionId: string) => void, onCancel: () => void): void {
    const picker = new SessionPicker(choices)
    picker.onSelect(onSelect)
    picker.onCancel(onCancel)
    picker.show(this.tui)
  }

  /** 注册 Ctrl+C 打断回调 */
  onAbort(cb: () => void): void {
    this.onAbortCb = cb
  }

  /** 注册空闲时退出回调。不注册则保持原来的直接退出。 */
  onExit(cb: () => void): void {
    this.onExitCb = cb
  }

  /**
   * 注册 stdin 读完的回调(只在非交互模式触发)。
   *
   * 管道输入常常是"给一行就结束",但那一行触发的回合可能还没跑完。
   * 收到这个信号后不要立刻退出,等回合跑完再退。
   */
  onInputClosed(cb: () => void): void {
    this.onInputClosedCb = cb
  }

  /** 启动界面 */
  start(): void {
    this.tui.start()
  }

  /** 停止界面,清理终端状态 */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.tui.stop()
  }

  /**
   * 退出前把最后一帧渲染出来。
   *
   * requestRender 是 process.nextTick 里的异步调度——
   * 直接退出进程的话,最后一帧还没画就被杀了,输出会缺一截。
   * renderNow 是同步的,退出前调一次能保证内容完整。
   */
  flush(): void {
    if (this.stopped) return
    this.tui.renderNow()
  }

  /** 注册 Shift+Tab 的回调。只在交互模式会触发。 */
  onModeCycle(cb: () => void): void {
    this.onModeCycleCb = cb
  }

  /**
   * 更新状态行上的沙盒模式。
   *
   * danger-full-access 用错误色:它和另外两个不是一个量级的东西,
   * 不能让人以为只是换了个开关。
   */
  setMode(mode: SandboxMode): void {
    const label = `沙盒 ${MODE_LABELS[mode]} · Shift+Tab 切换`
    this.modeLine.setText(mode === 'danger-full-access' ? errorText(label) : mutedText(label))
    this.tui.requestRender()
  }

  /** agent 开始运行时调用:锁住输入框 */
  setBusy(busy: boolean): void {
    this.busy = busy
    // 打断后不能直接解锁——用户可能还在按 Ctrl+C,编辑器会立刻再次提交。
    // 回合真正结束时由 cli 层调用 setBusy(false) 解锁。
    this.editor.disableSubmit = busy
    this.tui.requestRender()
  }

  /** 流式打印 assistant 文本增量 */
  printText(delta: string): void {
    this.streamingContent += delta
    // 第一段增量到达时才建组件——之前没有内容,建了也是空的
    if (!this.streamingText) {
      this.streamingText = new Text(this.streamingContent, EDITOR_PADDING_X, 0)
      this.transcript.addChild(this.streamingText)
    } else {
      this.streamingText.setText(this.streamingContent)
    }
    this.tui.requestRender()
  }

  /** 回合结束:把流式文本换成排好版的 Markdown */
  finishTurn(): void {
    if (!this.streamingText) return
    const content = this.streamingContent
    const position = this.transcript.children.indexOf(this.streamingText)

    // 空回复不建 Markdown 组件,不然会留一块空白
    if (content.trim()) {
      const markdown = new Markdown(content, EDITOR_PADDING_X, 0, markdownTheme)
      if (position >= 0) {
        this.transcript.children.splice(position, 1, markdown)
      } else {
        this.transcript.addChild(markdown)
      }
    } else if (position >= 0) {
      this.transcript.children.splice(position, 1)
    }

    this.streamingText = null
    this.streamingContent = ''
    this.tui.requestRender()
  }

  /** 打印工具调用 */
  printToolCall(name: string, args: unknown): void {
    // 工具调用和工具结果不在同一个流式块里,先把流式块收尾
    this.finishTurn()
    const line = new Text(`${toolName(name)} ${mutedText(formatToolArgs(args))}`, EDITOR_PADDING_X, 0)
    this.transcript.addChild(line)
    this.tui.requestRender()
  }

  /** 打印工具结果 */
  printToolResult(name: string, result: string): void {
    this.finishTurn()
    const line = new Text(`${toolName(name)} ${toolResult(result)}`, EDITOR_PADDING_X, 0)
    this.transcript.addChild(line)
    this.tui.requestRender()
  }

  /** 打印一行提示信息 */
  printNotice(message: string): void {
    this.finishTurn()
    this.transcript.addChild(new Text(mutedText(message), EDITOR_PADDING_X, 0))
    this.tui.requestRender()
  }

  /** 打印一行错误 */
  printError(message: string): void {
    this.finishTurn()
    this.transcript.addChild(new Text(errorText(message), EDITOR_PADDING_X, 0))
    this.tui.requestRender()
  }

  /** 打印标题(启动时用) */
  printHeader(message: string): void {
    this.transcript.addChild(new Text(accentText(message), EDITOR_PADDING_X, 1))
    this.tui.requestRender()
  }

  /**
   * 清空对话记录。
   *
   * 切换会话时用——新会话的历史跟旧的不是一回事,
   * 混在一起看会以为模型记错了。
   */
  clearTranscript(): void {
    this.transcript.clear()
    this.streamingText = null
    this.streamingContent = ''
    this.tui.requestRender()
  }

  /** 用户提交输入时的回调由 cli 层接管,这里只暴露设置入口 */
  bindSubmit(handler: (text: string) => void): void {
    this.editor.onSubmit = (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      this.editor.addToHistory(trimmed)
      // 先占住后续行，再把当前行交给上层。
      // 上层马上会 await，管道里已经缓冲的下一行会在那之前到达。
      this.holdIncomingLines()
      handler(trimmed)
    }
  }

  /**
   * 向用户提一个问题，并等一次回答。
   *
   * 交互模式临时打开输入框，但保持 busy——这时 Ctrl+C 仍是打断回合，不是退出进程。
   * 这次提交只作为回答返回，不会再走 bindSubmit，否则会嵌进一个新回合。
   * 非交互模式从行队列里取。输入已经结束就告诉调用方没有用户。
   */
  ask(question: string, signal?: AbortSignal): Promise<UserReply> {
    this.finishTurn()
    this.transcript.addChild(new Text(accentText(`? ${question}`), EDITOR_PADDING_X, 0))
    this.tui.requestRender()

    if (signal?.aborted) return Promise.resolve({ status: 'aborted' })

    if (this.terminal instanceof NonInteractiveTerminal) {
      return this.askFromLineQueue(this.terminal, signal)
    }
    return this.askFromEditor(signal)
  }

  /**
   * 取出回合进行中到达的下一行非空输入。
   * 没有的话放开占线，之后的行重新走编辑器。
   */
  takeNextHeldLine(): string | undefined {
    if (!(this.terminal instanceof NonInteractiveTerminal)) return undefined
    while (true) {
      const line = this.terminal.shiftLine()
      if (line === undefined) {
        this.terminal.setHoldLines(false)
        return undefined
      }
      const trimmed = line.trim()
      if (trimmed) return trimmed
    }
  }

  private holdIncomingLines(): void {
    if (this.terminal instanceof NonInteractiveTerminal) {
      this.terminal.setHoldLines(true)
    }
  }

  private async askFromLineQueue(
    terminal: NonInteractiveTerminal,
    signal?: AbortSignal,
  ): Promise<UserReply> {
    while (true) {
      if (signal?.aborted) return { status: 'aborted' }
      const line = await terminal.takeLine(signal)
      if (signal?.aborted) return { status: 'aborted' }
      if (line === null) return { status: 'unavailable' }
      const trimmed = line.trim()
      // 空行和普通提交一样忽略，继续等一句真的回答
      if (trimmed) return { status: 'answered', answer: trimmed }
    }
  }

  private askFromEditor(signal?: AbortSignal): Promise<UserReply> {
    const previousSubmit = this.editor.onSubmit
    return new Promise((resolve) => {
      let settled = false
      const finish = (reply: UserReply): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        this.editor.onSubmit = previousSubmit
        // 回合还没结束，输入框继续锁着，避免回答之后立刻又提交出一轮
        this.editor.disableSubmit = true
        resolve(reply)
      }
      const onAbort = (): void => finish({ status: 'aborted' })
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          finish({ status: 'aborted' })
          return
        }
      }
      this.editor.onSubmit = (text) => {
        const trimmed = text.trim()
        if (!trimmed) return
        this.editor.addToHistory(trimmed)
        finish({ status: 'answered', answer: trimmed })
      }
      this.editor.disableSubmit = false
      this.tui.requestRender()
    })
  }
}
