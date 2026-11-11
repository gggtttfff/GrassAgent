// src/instructions/prompts.ts
// 提示模板 —— 工作区里的 .grass/prompts/*.md,每份变成一条斜杠命令。
//
// 为什么需要它:斜杠命令全硬编码在 cli.ts 里,用户加不了自己的。
// 但「每次都要说一遍的那段话」——固化一条结论、里程碑存档、设定目标——
// 正是最适合做成命令的东西。
//
// 执行方式等价于「把展开后的文本当成一条用户消息发给模型」,
// 和手打进去完全一样。这样钩子、会话存储、回合计数都不用另外接一遍。
//
// 模板语法:
//   正文里的 $ARGUMENTS 换成命令后面跟的全部参数
//   正文里的 $1 换成第一个参数,$2 第二个,最多到 $9
//
// 模板文件本身是仓库里的文本,模型读得到的东西就都是用户授权的。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { splitFrontmatter } from '../core/frontmatter.ts'

/** 模板目录。工作区相对路径。 */
export const PROMPT_DIRECTORY = '.grass/prompts'

/** 一份提示模板。 */
export interface PromptTemplate {
  /** 命令名。不带斜杠。 */
  name: string
  /** 一句话说明,显示在补全列表里。 */
  description: string
  /** 参数提示,显示在补全列表里。 */
  argumentHint?: string
  /** 模板正文,还没展开参数。 */
  body: string
  /** 工作区内相对路径。 */
  relativePath: string
}

export interface PromptTemplateLog {
  warn(object: object, message: string): void
  info(object: object, message: string): void
}

/** 命令名能不能当斜杠命令名。规则和技能名一致。 */
export function isUsablePromptCommandName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name)
}

/**
 * 展开模板里的参数占位符。
 *
 * $ARGUMENTS 是全部参数,$1..$9 是单个参数。
 * 没有参数时占位符换成空串,不留下 "$ARGUMENTS" 这种痕迹。
 */
export function expandPromptTemplate(body: string, argument: string): string {
  const trimmed = argument.trim()
  const parts = trimmed ? trimmed.split(/\s+/) : []
  return body
    .replaceAll('$ARGUMENTS', trimmed)
    .replace(/\$(\d)/g, (_match, digit: string) => {
      const index = Number(digit) - 1
      return index >= 0 && index < parts.length ? parts[index]! : ''
    })
}

/**
 * 从一行输入里找出匹配的模板命令。
 *
 * 只认第一行、必须以 / 开头——和内置斜杠命令同一套规则,
 * 免得同一个输入在两处被理解成不同东西。
 */
export function matchPromptTemplate(
  templates: readonly PromptTemplate[],
  input: string,
): { template: PromptTemplate; argument: string } | undefined {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return undefined

  const firstLine = trimmed.split('\n')[0]!.trim()
  const withoutSlash = firstLine.slice(1)
  if (!withoutSlash) return undefined

  const spaceIndex = withoutSlash.indexOf(' ')
  const name = spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex)
  const argument = spaceIndex === -1 ? '' : withoutSlash.slice(spaceIndex + 1).trim()

  const template = templates.find((item) => item.name === name)
  if (!template) return undefined
  return { template, argument }
}

/**
 * 读工作区里的模板目录。
 *
 * 目录不存在是正常状态(大多数项目没有模板),返回空列表。
 * 单个文件读坏了只跳过那一个,不能让整份清单废掉。
 */
export async function discoverPromptTemplates(
  workspace: string,
  logger?: PromptTemplateLog,
): Promise<PromptTemplate[]> {
  const directory = path.join(workspace, PROMPT_DIRECTORY)
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    logger?.warn({ directory, errorMessage: (error as Error).message }, '读取提示模板目录失败,已跳过')
    return []
  }

  const templates: PromptTemplate[] = []
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const filePath = path.join(directory, entry)
    try {
      const stats = await fs.stat(filePath)
      if (!stats.isFile()) continue
      const text = await fs.readFile(filePath, 'utf8')
      const template = parsePromptTemplate(text, entry.replace(/\.md$/i, ''), filePath)
      if (!template) {
        logger?.warn({ path: filePath }, '提示模板内容不完整,已跳过')
        continue
      }
      templates.push(template)
    } catch (error) {
      logger?.warn({ path: filePath, errorMessage: (error as Error).message }, '读提示模板失败,已跳过')
    }
  }

  templates.sort((left, right) => left.name.localeCompare(right.name))
  logger?.info({ promptCount: templates.length }, '提示模板已识别')
  return templates
}

/**
 * 解析一份模板。
 *
 * 没有 frontmatter 也没有正文的一律跳过——空模板执行出来是空白。
 * 描述缺了可以从正文第一行取,取不到就跳过:
 * 描述是补全列表里唯一的说明,没有它用户不知道这条命令干什么。
 */
function parsePromptTemplate(
  text: string,
  fallbackName: string,
  filePath: string,
): PromptTemplate | undefined {
  const { data, body } = splitFrontmatter(text)
  const name = stringValue(data.name) ?? fallbackName
  const trimmedBody = body.trim()
  if (!name || !trimmedBody) return undefined

  const description = stringValue(data.description) ?? firstHeading(trimmedBody)
  if (!description) return undefined

  return {
    name,
    description,
    argumentHint: stringValue(data['argument-hint']) ?? stringValue(data.argumentHint),
    body: trimmedBody,
    relativePath: path.posix.join(PROMPT_DIRECTORY, path.basename(filePath)),
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body)
  return match?.[1]?.trim()
}
