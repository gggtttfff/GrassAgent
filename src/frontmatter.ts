// src/frontmatter.ts
// SKILL.md、规则文件开头的 YAML 头 —— 只认这一小撮语法。
//
// 完整 YAML 解析要引依赖,而这些文件是各家工具写给人看的,
// 实际用到的只有 `key: value`、`key:` 加 `  - item`、以及 `key: >-` 折叠块。
// 自己解析够用,坏行跳过也不会把整份文件废掉。

export type FrontmatterValue = string | boolean | string[]

/** 拆出 `---` 包围的头和正文。没有头时整篇都是正文。行尾统一成 \n。 */
export function splitFrontmatter(text: string): { data: Record<string, FrontmatterValue>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized }
  const closing = normalized.indexOf('\n---', 3)
  if (closing === -1) return { data: {}, body: normalized }
  const raw = normalized.slice(4, closing)
  let body = normalized.slice(closing + 4)
  if (body.startsWith('\n')) body = body.slice(1)
  return { data: parseFrontmatterYaml(raw), body }
}

export function parseFrontmatterYaml(raw: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {}
  let listKey: string | undefined
  let block: { key: string; folded: boolean; lines: string[] } | undefined

  const flushBlock = () => {
    if (!block) return
    data[block.key] = collapseBlock(block.lines, block.folded)
    block = undefined
  }

  for (const line of raw.split('\n')) {
    // 块标量:后续缩进行都属于上一个 key,缩进消失才算结束
    if (block) {
      if (!line.trim()) {
        block.lines.push('')
        continue
      }
      if (/^\s/.test(line)) {
        block.lines.push(line)
        continue
      }
      flushBlock()
    }
    if (!line.trim() || line.trim().startsWith('#')) continue
    const listItem = /^\s+-\s+(.*)$/.exec(line)
    if (listItem && listKey) {
      const current = data[listKey]
      const items = Array.isArray(current) ? current : []
      const value = unquote(listItem[1].trim())
      if (value) items.push(value)
      data[listKey] = items
      continue
    }
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!field) continue
    const key = field[1]
    const value = field[2].trim()
    if (!value) {
      listKey = key
      data[key] = []
      continue
    }
    listKey = undefined
    // `>-` `>+` `|` `|-` 都是块标量,`>` 折叠成空格,`|` 保留换行
    const blockMarker = /^([>|])[+-]?$/.exec(value)
    if (blockMarker) {
      block = { key, folded: blockMarker[1] === '>', lines: [] }
      continue
    }
    data[key] = parseScalar(key, value)
  }
  flushBlock()
  return data
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

// 块标量的内容整体缩进了一级,先按最小缩进量削平再折叠。
function collapseBlock(lines: string[], folded: boolean): string {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^\s*/.exec(line)?.[0].length ?? 0)
  const sharedIndent = indents.length > 0 ? Math.min(...indents) : 0
  const stripped = lines.map((line) => line.slice(Math.min(sharedIndent, line.length)))
  while (stripped.length > 0 && !(stripped[stripped.length - 1] ?? '').trim()) stripped.pop()
  if (!folded) return stripped.join('\n').trim()
  // 折叠:同一段里的换行变空格,空行分隔段落
  return stripped
    .join('\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .join('\n')
    .trim()
}