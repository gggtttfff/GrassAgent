// src/theme.ts
// 终端配色 —— 给 pi-tui 的组件用。
//
// 单独成文件:主题是"长得很像配置"的东西,和 UI 逻辑分开,
// 换配色不用动渲染代码。
//
// 颜色用 pi-tui 自带的 styleText,不用 chalk:
// chalk 是 pi 的开发依赖,不是 pi-tui 的依赖,引入它等于多一个运行时依赖。
// styleText 还会按终端能力降级(真彩色 -> 256 色),自己拼 ANSI 码做不到这个。

import {
  styleText,
  getTerminalColorMode,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
  type TerminalColorMode,
  type TextAttributes,
  type TextStyle,
} from '@earendil-works/pi-tui'

// 终端颜色模式。整进程只检测一次——
// 每次渲染都问一遍终端能力会拖慢帧率。
let cachedColorMode: TerminalColorMode | undefined

export function terminalColorMode(): TerminalColorMode {
  cachedColorMode ??= getTerminalColorMode()
  return cachedColorMode
}

// 调色板。用 256 色索引而不是 RGB:
// 大多数终端的调色板是固定的,索引色在不同终端之间表现一致,
// RGB 真彩色在老终端上会被降级成很难看的近似色。
const palette = {
  accent: 45,   // 青蓝 —— 标题、选中项
  info: 39,     // 蓝 —— 工具名
  success: 42,  // 绿 —— 工具结果
  warning: 214, // 橙 —— 错误提示
  muted: 244,   // 灰 —— 次要信息
  code: 208,    // 橙黄 —— 行内代码
  codeBlock: 114, // 绿 —— 代码块
} as const

// 套一层样式。mode 已经缓存,这里不做额外判断。
function styled(text: string, style: TextStyle, attributes: TextAttributes = {}): string {
  return styleText(text, { ...style, ...attributes }, terminalColorMode())
}

// 前景色 + 属性
function foreground(text: string, colorIndex: number, attributes?: TextAttributes): string {
  return styled(text, { fg: { kind: 'indexed', index: colorIndex } }, attributes)
}

// 弱化文字。dim 是终端最通用的"次要信息"表达,兼容性最好。
function dim(text: string): string {
  return styled(text, {}, { dim: true })
}

// 选中文本主题
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => foreground(text, palette.accent),
  selectedText: (text) => styled(text, { fg: { kind: 'indexed', index: palette.accent } }, { bold: true }),
  description: (text) => foreground(text, palette.muted),
  scrollInfo: (text) => dim(text),
  noMatch: (text) => dim(text),
}

// 会话选择器里当前会话的标记
export function currentSessionMarker(text: string): string {
  return foreground(text, palette.success, { bold: true })
}

export function overlayTitle(text: string): string {
  return foreground(text, palette.accent, { bold: true })
}

// 编辑器主题
export const editorTheme: EditorTheme = {
  borderColor: (text) => dim(text),
  selectList: selectListTheme,
}

// Markdown 主题。
// 模型输出的常见结构都覆盖到了:标题、代码、列表、引用、链接。
export const markdownTheme: MarkdownTheme = {
  heading: (text) => foreground(text, palette.accent, { bold: true }),
  link: (text) => foreground(text, palette.info, { underline: true }),
  linkUrl: (text) => dim(text),
  code: (text) => foreground(text, palette.code),
  codeBlock: (text) => foreground(text, palette.codeBlock),
  codeBlockBorder: (text) => dim(text),
  quote: (text) => styled(text, {}, { italic: true }),
  quoteBorder: (text) => foreground(text, palette.muted),
  hr: (text) => dim(text),
  listBullet: (text) => foreground(text, palette.accent),
  bold: (text) => styled(text, {}, { bold: true }),
  italic: (text) => styled(text, {}, { italic: true }),
  strikethrough: (text) => styled(text, {}, { strikethrough: true }),
  underline: (text) => styled(text, {}, { underline: true }),
}

// 工具调用的名字
export function toolName(text: string): string {
  return foreground(text, palette.info, { bold: true })
}

// 工具执行成功
export function toolResult(text: string): string {
  return foreground(text, palette.success)
}

// 错误提示
export function errorText(text: string): string {
  return foreground(text, palette.warning)
}

// 次要信息(时间戳、提示语之类)
export function mutedText(text: string): string {
  return dim(text)
}

// 强调色文字(用户输入、标题)
export function accentText(text: string): string {
  return foreground(text, palette.accent, { bold: true })
}
