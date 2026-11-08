// src/slashCommands.ts
// 斜杠命令 —— 用户输入以 / 开头时,交给本地处理,不发给模型。
//
// 命令和普通输入走同一个输入框。pi-tui 的编辑器把 '/' 开头的输入
// 当成命令上下文,自动弹出补全列表——补全逻辑直接用它给的
// CombinedAutocompleteProvider,不用自己写。
//
// 分发规则:
//   以 / 开头   -> 本地执行,不发给模型(命令名拼错也要拦下来报错)
//   其他         -> 正常输入,发给模型
//
// 命令解析放在这一层,TUI 只管显示,cli 只管把结果接到会话上。

/** 一条斜杠命令的定义 */
export interface SlashCommand {
  /** 命令名,不带斜杠 */
  name: string
  /** 一句话说明,显示在补全列表里 */
  description: string
  /** 参数提示,显示在补全列表里 */
  argumentHint?: string
  /** 执行命令。返回值是给用户看的结果文本 */
  execute: (argument: string) => string | Promise<string>
}

/** 命令解析的结果 */
export type CommandParseResult =
  | { kind: 'command'; name: string; argument: string }
  | { kind: 'not_a_command' }

/**
 * 解析一行输入。
 *
 * 只认第一行、且必须以 / 开头——多行输入里第二行开始的 / 是正文。
 */
export function parseSlashCommand(input: string): CommandParseResult {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return { kind: 'not_a_command' }

  // 只看第一行:多行输入里后面的 / 是正文的一部分
  const firstLine = trimmed.split('\n')[0].trim()
  const withoutSlash = firstLine.slice(1)
  if (!withoutSlash) return { kind: 'not_a_command' }

  const spaceIndex = withoutSlash.indexOf(' ')
  if (spaceIndex === -1) {
    return { kind: 'command', name: withoutSlash, argument: '' }
  }
  return {
    kind: 'command',
    name: withoutSlash.slice(0, spaceIndex),
    argument: withoutSlash.slice(spaceIndex + 1).trim(),
  }
}

/**
 * 命令表。
 *
 * 命令的实现从外面注入——这里只管名字、说明和分发。
 * 实际做什么(切会话、列会话)是会话层的事,TUI 不该知道。
 */
export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommand>()

  /** 注册一条命令。同名命令会被覆盖。 */
  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
  }

  /** 按名字找命令 */
  find(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }

  /** 已注册的命令名,按字母序 */
  names(): string[] {
    return [...this.commands.keys()].sort()
  }

  /** 所有命令,用来生成补全列表 */
  all(): SlashCommand[] {
    return this.names().map((name) => this.commands.get(name)!)
  }

  /** 未知命令时的提示,列出所有可用命令 */
  private unknownCommandMessage(name: string): string {
    return `未知命令 /${name},可用命令:${this.names().map((item) => `/${item}`).join(' ')}`
  }

  /**
   * 执行一行输入。
   *
   * 返回 null 表示这不是命令,交给上层当普通输入处理。
   * 未知命令会返回一条错误提示——拼错的命令不该被当成普通输入发给模型。
   */
  async execute(input: string): Promise<string | null> {
    const parsed = parseSlashCommand(input)
    if (parsed.kind === 'not_a_command') return null

    const command = this.find(parsed.name)
    if (!command) return this.unknownCommandMessage(parsed.name)

    try {
      return await command.execute(parsed.argument)
    } catch (error) {
      // 命令执行失败不该整个崩掉,把错误显示给用户就行
      return `命令 /${parsed.name} 执行失败:${(error as Error).message}`
    }
  }
}
