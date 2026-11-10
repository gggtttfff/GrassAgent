// src/core/frontmatter.ts
// SKILL.md、规则文件开头的 YAML 头 —— 只认这一小撮语法。
//
// 完整 YAML 解析要引依赖,而这些文件是各家工具写给人看的,
// 实际用到的只有 `key: value`、`key:` 加 `  - item`、`key: >-` 折叠块,
// 以及 `key:` 下再嵌一层的映射。自己解析够用,坏行跳过也不会把整份文件废掉。

export type FrontmatterValue = string | boolean | string[] | FrontmatterMapping

/** 嵌套一层的映射。比如 metadata.surfaces。 */
export interface FrontmatterMapping {
  [key: string]: string | boolean | string[]
}

/**
 * 拆出 `---` 包围的头和正文。没有头时整篇都是正文。行尾统一成 \n。
 *
 * bodyStartLine 是正文第一行在原文件里的行号(从 1 开始)。
 * 技能用它把标题的行号换算成文件行号,模型才能拿 read_file 定位。
 */
export function splitFrontmatter(text: string): {
  data: Record<string, FrontmatterValue>
  body: string
  bodyStartLine: number
} {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized, bodyStartLine: 1 }
  const closing = normalized.indexOf('\n---', 3)
  if (closing === -1) return { data: {}, body: normalized, bodyStartLine: 1 }
  const raw = normalized.slice(4, closing)
  let body = normalized.slice(closing + 4)
  if (body.startsWith('\n')) body = body.slice(1)
  // 头占了几行:'---\n' 一行,头本身几行,收尾的 '---' 一行
  const headerLines = raw.split('\n').length
  return { data: parseFrontmatterYaml(raw), body, bodyStartLine: headerLines + 3 }
}

interface Token {
  /** 缩进空格数 */
  indent: number
  /** 去掉缩进后的内容 */
  content: string
  /** 空行。块标量里要留着,别的场合直接跳过。 */
  blank: boolean
}

export function parseFrontmatterYaml(raw: string): Record<string, FrontmatterValue> {
  const tokens = tokenize(raw)
  const baseIndent = tokens.find((token) => !token.blank)?.indent ?? 0
  const parsed = parseMapping(tokens, 0, baseIndent)
  return parsed.value
}

function tokenize(raw: string): Token[] {
  const tokens: Token[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      tokens.push({ indent: 0, content: '', blank: true })
      continue
    }
    if (line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    tokens.push({ indent, content: line.trim(), blank: false })
  }
  return tokens
}

interface MappingResult {
  value: Record<string, FrontmatterValue>
  next: number
}

function parseMapping(tokens: Token[], start: number, indent: number): MappingResult {
  const data: Record<string, FrontmatterValue> = {}
  let position = start
  while (position < tokens.length) {
    const token = tokens[position]!
    if (token.blank) {
      position++
      continue
    }
    if (token.indent < indent) break
    if (token.indent > indent) {
      // 缩进更深却不属于任何键,说明结构坏了,跳过这一行继续
      position++
      continue
    }
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(token.content)
    if (!field) {
      position++
      continue
    }
    const key = field[1]!
    const rest = field[2]!.trim()

    // 块标量:`>` 折叠成空格,`|` 保留换行
    const blockMarker = /^([>|])[+-]?$/.exec(rest)
    if (blockMarker) {
      const collected = collectBlock(tokens, position + 1, indent)
      data[key] = collapseBlock(collected.lines, blockMarker[1] === '>')
      position = collected.next
      continue
    }

    if (rest) {
      data[key] = parseScalar(key, rest)
      position++
      continue
    }

    // 冒号后面没值:看下面有没有更深的一层,决定是嵌套映射还是列表
    const nested = parseNested(tokens, position + 1, indent)
    data[key] = nested.value
    position = nested.next
  }
  return { value: data, next: position }
}

interface NestedResult {
  value: string[] | FrontmatterMapping
  next: number
}

function parseNested(tokens: Token[], start: number, indent: number): NestedResult {
  let position = start
  // 找到下一段有效内容,空行不算
  while (position < tokens.length && tokens[position]!.blank) position++
  const first = tokens[position]
  if (!first || first.indent <= indent) {
    // 没有更深的一层,空的列表
    return { value: [], next: start }
  }

  // 列表项:`- item`
  if (/^- /.test(first.content)) {
    const items: string[] = []
    while (position < tokens.length) {
      const token = tokens[position]!
      if (token.blank) {
        position++
        continue
      }
      if (token.indent <= indent) break
      const item = /^- (.*)$/.exec(token.content)
      if (!item) break
      const value = unquote(item[1]!.trim())
      if (value) items.push(value)
      position++
    }
    return { value: items, next: position }
  }

  // 嵌套映射
  const parsed = parseMapping(tokens, start, first.indent)
  return { value: parsed.value as FrontmatterMapping, next: parsed.next }
}

function collectBlock(tokens: Token[], start: number, indent: number): { lines: string[]; next: number } {
  const lines: string[] = []
  let position = start
  while (position < tokens.length) {
    const token = tokens[position]!
    if (token.blank) {
      lines.push('')
      position++
      continue
    }
    if (token.indent <= indent) break
    lines.push(token.content)
    position++
  }
  // 收尾的空行不算块的内容
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { lines, next: position }
}

function parseScalar(key: string, value: string): FrontmatterValue {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((part) => unquote(part.trim())).filter(Boolean)
  }
  const unquoted = unquote(value)
  if (unquoted === 'true') return true
  if (unquoted === 'false') return false
  if (
    (key === 'globs' || key === 'paths' || key === 'fileMatchPattern' || key === 'fileMatch')
    && unquoted.includes(',')
  ) {
    return unquoted.split(',').map((part) => part.trim()).filter(Boolean)
  }
  return unquoted
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

// 折叠块里相邻的非空行用空格连起来,空行分隔段落。
function collapseBlock(lines: string[], folded: boolean): string {
  if (!folded) return lines.join('\n').trim()
  return lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
    .trim()
}
