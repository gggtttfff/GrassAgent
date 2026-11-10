// src/skills.ts
// 技能 —— 工作区里的技能包,模型按名字加载。
//
// 正文不进系统提示词,只列名字和描述:一个技能动辄几百行,每轮都塞进去会挤掉对话。
// 模型判断任务对得上时调 load_skill 取全文,再按正文去读附件。
//
// 技能从「执行世界」里读,本地和远程走同一套扫描逻辑:
// 远程世界里的文件在另一台机器上,本机 fs 读不到。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ExecutionWorld } from './executionWorld.ts'
import { splitFrontmatter } from './frontmatter.ts'
import { createPathGuard, type PathGuard } from './pathGuard.ts'

export type SkillSource = 'grass' | 'cursor' | 'claude' | 'kiro' | 'opencode'

/** 技能是从哪儿读到的。本地和远程要分开标,不然模型分不清自己在改哪台机器上的文件。 */
export interface SkillOrigin {
  kind: 'local' | 'remote'
  /** 给模型看的来源说明。远程时是 user@host:port 之类。 */
  label: string
}

export interface Skill {
  /** load_skill 用的名字。同名时先扫到的根优先。 */
  name: string
  description: string
  /** 工作区内相对路径,指向 SKILL.md。正文被截断时靠它读全文。 */
  relativePath: string
  /** SKILL.md 所在目录,附件在该目录下 */
  directoryPath: string
  body: string
  /** 正文超过上限被截断过 */
  truncated: boolean
  source: SkillSource
  origin: SkillOrigin
  /** 被禁用时写明原因。禁用的技能不进索引,load_skill 也取不到。 */
  disabledReason?: string
  /**
   * 只允许用户手敲,模型不能自己调。
   * 这类技能不进索引,注册成斜杠命令。
   */
  commandOnly: boolean
  /** 技能目录下的附件。模型按名字用 read_file 读。 */
  attachments: string[]
}

export interface SkillCatalog {
  skills: Skill[]
  /** 拼到系统提示词后面的段落。没有技能时是空字符串。 */
  promptSection: string
}

export interface SkillRegistry {
  names(): string[]
  find(name: string): Skill | undefined
}

export interface SkillLog {
  warn(object: object, message: string): void
  info(object: object, message: string): void
}

/** 目录里的一个条目。size 和 mtimeMs 用来判断文件有没有变过。 */
export interface SkillFileEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
  mtimeMs?: number
}

/**
 * 技能扫描要用的文件接口。路径一律是工作区相对路径。
 *
 * 抽出来是因为本地和远程的字节不在一处:
 * 本地走 fs + 路径沙箱,远程走执行世界。
 */
export interface SkillFileSystem {
  /** 列出工作区相对目录下的直接子项 */
  listEntries(relativeDirectory: string): Promise<SkillFileEntry[]>
  /** 读工作区相对路径的文本。读不到、太大或不是文本时返回 undefined */
  readText(relativePath: string): Promise<string | undefined>
}

// 顺序就是优先级:工作区自己的技能写在最前面,同名时不被别的工具覆盖。
const SKILL_ROOTS: readonly { directory: string; source: SkillSource }[] = [
  { directory: '.grass/skills', source: 'grass' },
  { directory: '.cursor/skills', source: 'cursor' },
  { directory: '.claude/skills', source: 'claude' },
  { directory: '.kiro/skills', source: 'kiro' },
  { directory: '.opencode/skills', source: 'opencode' },
]

const SKIP_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  'vendor', 'target', '.turbo', '.cache', '__pycache__',
])

const MAX_SKILL_BYTES = 256 * 1024
const MAX_SKILL_BODY_CHARS = 24_000
const MAX_SKILLS = 64
const MAX_DESCRIPTION_CHARS = 200
const SKILL_FILE_NAME = 'skill.md'

// 附件只列名字,数量和体积都要有上限,不然工具输出会被撑大
const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 256 * 1024

// 本地目录树浅一点没关系,远程每层目录都是一次往返。
const LOCAL_WALK_DEPTH = 6
const REMOTE_WALK_DEPTH = 3

// 文件里出现 NUL 说明是二进制,不能当技能正文。用码点写,免得源码里出现不可见字符。
const NUL_CHARACTER = String.fromCharCode(0)

const noopLog: SkillLog = { warn() {}, info() {} }

/**
 * 本地技能文件接口。软链和越界路径由路径沙箱挡住。
 */
export async function createLocalSkillFiles(workspace: string): Promise<SkillFileSystem> {
  const pathGuard = await createPathGuard(workspace)
  return {
    async listEntries(relativeDirectory: string): Promise<SkillFileEntry[]> {
      const resolved = await pathGuard.resolve(relativeDirectory)
      const entries = await fs.readdir(resolved, { withFileTypes: true })
      const result: SkillFileEntry[] = []
      for (const entry of entries) {
        const child = path.join(resolved, entry.name)
        // 软链要先确认落在工作区内,否则等于借技能读到外面去
        if (entry.isSymbolicLink() && !(await pathGuard.isInside(child))) continue
        let size: number | undefined
        let mtimeMs: number | undefined
        let type: SkillFileEntry['type'] = 'other'
        try {
          const stats = await fs.stat(child)
          size = stats.size
          mtimeMs = stats.mtimeMs
          type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
        } catch {
          // 读不到就只留名字,判断不出类型就不当技能目录用
        }
        result.push({ name: entry.name, type, size, mtimeMs })
      }
      return result
    },
    async readText(relativePath: string): Promise<string | undefined> {
      const resolved = await pathGuard.resolve(relativePath)
      const stats = await fs.stat(resolved)
      if (stats.size > MAX_SKILL_BYTES) return undefined
      const text = await fs.readFile(resolved, 'utf8')
      if (text.includes(NUL_CHARACTER)) return undefined
      return text
    },
  }
}

/**
 * 远程技能文件接口。字节在沙盒里,一切都走执行世界。
 */
export function createWorldSkillFiles(world: ExecutionWorld): SkillFileSystem {
  return {
    async listEntries(relativeDirectory: string): Promise<SkillFileEntry[]> {
      return world.list(relativeDirectory)
    },
    async readText(relativePath: string): Promise<string | undefined> {
      const text = await world.readRaw(relativePath)
      if (!text) return undefined
      if (text.includes(NUL_CHARACTER)) return undefined
      return text
    },
  }
}

/**
 * 扫出工作区里的全部技能。识别失败不抛错——技能是锦上添花,不能挡启动。
 */
export async function discoverSkills(options: {
  files: SkillFileSystem
  origin: SkillOrigin
  logger?: SkillLog
}): Promise<SkillCatalog> {
  const logger = options.logger ?? noopLog
  const collected: Skill[] = []
  const maxDepth = options.origin.kind === 'remote' ? REMOTE_WALK_DEPTH : LOCAL_WALK_DEPTH

  for (const root of SKILL_ROOTS) {
    if (collected.length >= MAX_SKILLS) {
      logger.warn({ maxSkills: MAX_SKILLS }, '技能数量到上限,其余不再扫描')
      break
    }
    await collectSkillFiles(root.directory, root.directory, 0, root.source, {
      files: options.files,
      origin: options.origin,
      maxDepth,
      skills: collected,
      logger,
    })
  }

  // 同名技能全部禁用:挑一个留下的话,用户改到哪份都没法确定自己用的是哪份。
  // 全部禁用并告警,让人自己决定留哪一份。
  const skills = disableDuplicatedSkills(collected, logger)

  skills.sort((left, right) => left.name.localeCompare(right.name))
  logger.info({ skillCount: skills.length, origin: options.origin.label }, '技能已识别')
  return { skills, promptSection: renderSkillSection(skills) }
}

/**
 * 同名(不分大小写)的技能全部禁用,并把各自的来源和路径写进禁用原因。
 */
function disableDuplicatedSkills(skills: Skill[], logger: SkillLog): Skill[] {
  const groups = new Map<string, Skill[]>()
  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    const group = groups.get(key)
    if (group) group.push(skill)
    else groups.set(key, [skill])
  }

  const result: Skill[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0])
      continue
    }
    const detail = group
      .map((skill) => `${skill.relativePath}(来源:${skill.origin.label})`)
      .join('、')
    const reason = `存在 ${group.length} 个同名技能,已全部禁用:${detail}`
    logger.warn({ name: group[0]?.name, count: group.length, detail }, '同名技能已全部禁用')
    for (const skill of group) result.push({ ...skill, disabledReason: reason })
  }
  return result
}

export function createSkillRegistry(skills: readonly Skill[]): SkillRegistry {
  // 被禁用的技能不进注册表:模型问 load_skill 时找不到它,就不会拿一份来路不明的正文。
  // 只允许用户手敲的技能同样不进——模型不能自己调它们。
  const usable = skills.filter((skill) => !skill.disabledReason && !skill.commandOnly)
  const byExactName = new Map(usable.map((skill) => [skill.name, skill]))
  const byLowerCaseName = new Map<string, Skill>()
  for (const skill of usable) {
    const key = skill.name.toLowerCase()
    if (!byLowerCaseName.has(key)) byLowerCaseName.set(key, skill)
  }
  return {
    names: () => usable.map((skill) => skill.name),
    // 模型偶尔会把名字写成 /foo 或大小写不一致,这里兜一下
    find: (name) => {
      const trimmed = name.trim().replace(/^\//, '')
      if (!trimmed) return undefined
      return byExactName.get(trimmed) ?? byLowerCaseName.get(trimmed.toLowerCase())
    },
  }
}

export function renderSkillSection(skills: readonly Skill[]): string {
  const usable = skills.filter((skill) => !skill.disabledReason && !skill.commandOnly)
  if (usable.length === 0) return ''
  return [
    '## 可用技能',
    '下面是打包好的多步流程,正文没有放进上下文。',
    '任务和某条描述对得上时,先调用 load_skill 取全文,再按正文执行;不要凭名字猜步骤。',
    '没被点名、描述也对不上的技能不要用。',
    ...usable.map((skill) => `- ${skill.name}(来源:${skill.origin.label}): ${skill.description}`),
  ].join('\n')
}

/** 被禁用的技能和原因。启动时打给用户看,免得技能凭空消失。 */
export function describeDisabledSkills(skills: readonly Skill[]): string[] {
  return skills
    .filter((skill) => skill.disabledReason)
    .map((skill) => `技能 ${skill.name} 已禁用:${skill.disabledReason}`)
}

/** 只允许用户手敲的技能。 */
export function commandOnlySkills(skills: readonly Skill[]): Skill[] {
  return skills.filter((skill) => !skill.disabledReason && skill.commandOnly)
}

/** 技能名能不能当斜杠命令名。带斜杠或空格的名字在补全列表里会出问题。 */
export function isUsableCommandName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name)
}

/**
 * 只读技能被敲出来时的文本。
 *
 * 不发给模型——用户自己看到正文,再决定要不要粘给模型。
 * 参数原样带上,提示语要说清下一步该做什么。
 */
export function formatCommandOnlySkill(skill: Skill, argument: string): string {
  const lines = [`# 技能 ${skill.name}`, `来源:${skill.origin.label}`, `正文:${skill.relativePath}`, '']
  lines.push(skill.body)
  if (argument) {
    lines.push('', '---', `按上面的技能处理,参数:${argument}`)
  }
  lines.push('', '(这段正文只显示给你。要让模型照着做,把上面的内容发给它。)')
  return lines.join('\n')
}

/** load_skill 回给模型的文本:正文 + 附件目录提示。 */
export function formatSkillForModel(skill: Skill): string {
  const lines = [
    `# 技能 ${skill.name}`,
    `来源:${skill.origin.label}`,
    `正文:${skill.relativePath}`,
    `附件目录:${skill.directoryPath}(脚本、模板、参考文档在这里,用 read_file 按需读,不要整目录读)`,
  ]
  if (skill.attachments.length > 0) {
    lines.push(`附件:${skill.attachments.join('、')}`)
  }
  lines.push('', skill.body)
  if (skill.truncated) {
    lines.push(
      '',
      '---',
      `正文超过 ${MAX_SKILL_BODY_CHARS} 字已截断,完整内容用 read_file 读 ${skill.relativePath}。`,
    )
  }
  return lines.join('\n')
}

export function summarizeSkills(skills: readonly Skill[]): string {
  const usable = skills.filter((skill) => !skill.disabledReason)
  const disabled = skills.length - usable.length
  if (usable.length === 0) {
    return disabled > 0 ? `技能全部被禁用(${disabled} 个)` : '项目里没有找到技能'
  }
  const suffix = disabled > 0 ? `,另有 ${disabled} 个同名冲突被禁用` : ''
  return `已识别技能 ${usable.length} 个:${usable.map((skill) => skill.name).join('、')}${suffix}`
}

interface CollectContext {
  files: SkillFileSystem
  origin: SkillOrigin
  maxDepth: number
  skills: Skill[]
  logger: SkillLog
}

async function collectSkillFiles(
  rootDirectory: string,
  directory: string,
  depth: number,
  source: SkillSource,
  context: CollectContext,
): Promise<void> {
  if (depth > context.maxDepth) return
  const entries = await listEntries(directory, context)
  for (const entry of entries) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue
    const child = joinRelative(directory, entry.name)
    if (entry.type === 'directory') {
      await collectSkillFiles(rootDirectory, child, depth + 1, source, context)
      continue
    }
    if (entry.type !== 'file' || entry.name.toLowerCase() !== SKILL_FILE_NAME) continue
    await loadSkill(child, rootDirectory, source, context)
  }
}

async function loadSkill(
  filePath: string,
  rootDirectory: string,
  source: SkillSource,
  context: CollectContext,
): Promise<void> {
  const text = await context.files.readText(filePath)
  if (text === undefined) {
    context.logger.warn({ path: filePath }, '技能文件读不到或不是文本,已跳过')
    return
  }

  const { data, body } = splitFrontmatter(text)
  // 没写 name 就用它在技能根下的目录名,允许多级,比如 "review/pr"
  const directoryName = relativeOf(rootDirectory, filePath)
  const name = (stringValue(data.name) ?? directoryName).trim()
  const description = clipDescription(stringValue(data.description) ?? firstHeading(body))
  if (!name) {
    context.logger.warn({ path: filePath }, '技能没有名字,已跳过')
    return
  }
  // 没有描述模型就判断不出什么时候该用它,留在索引里反而白占上下文
  if (!description) {
    context.logger.warn({ path: filePath, name }, '技能没有描述,已跳过')
    return
  }
  // 同名的先都留着,扫完再一起判断要不要全禁。
  // 这里提前丢掉一个的话,就看不出是同名冲突,只当它不存在。
  const normalizedBody = body.replaceAll(NUL_CHARACTER, '').trim()
  if (!normalizedBody) {
    context.logger.warn({ path: filePath, name }, '技能正文是空的,已跳过')
    return
  }

  const truncated = normalizedBody.length > MAX_SKILL_BODY_CHARS
  const attachments = await collectAttachments(parentOf(filePath), context)
  context.skills.push({
    name,
    description,
    relativePath: filePath,
    directoryPath: parentOf(filePath),
    body: truncated ? normalizedBody.slice(0, MAX_SKILL_BODY_CHARS) : normalizedBody,
    truncated,
    source,
    origin: context.origin,
    commandOnly: isCommandOnly(data),
    attachments,
  })
}

/**
 * 技能目录下的附件。
 *
 * 只列名字:模型按名字自己 read_file。列太细会把工具输出撑大,
 * 而且模型真正要读哪个文件,它读完正文就知道了。
 */
async function collectAttachments(directory: string, context: CollectContext): Promise<string[]> {
  if (!directory) return []
  const entries = await listEntries(directory, context)
  const files: string[] = []
  for (const entry of entries) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue
    // SKILL.md 本身不算附件
    if (entry.name.toLowerCase() === SKILL_FILE_NAME) continue
    if (entry.type !== 'file') continue
    // 超大的文件多半是数据集,列出来也没法用
    if (entry.size !== undefined && entry.size > MAX_ATTACHMENT_BYTES) continue
    files.push(`${directory}/${entry.name}`)
  }
  return files.sort().slice(0, MAX_ATTACHMENTS)
}

/**
 * 只允许用户手敲的技能。
 * Cursor 的写法是 disable-model-invocation,Claude 的写法是 disable-model-invocation,
 * 驼峰写法也认。
 */
function isCommandOnly(data: Record<string, unknown>): boolean {
  return data['disable-model-invocation'] === true || data.disableModelInvocation === true
}

async function listEntries(directory: string, context: CollectContext): Promise<SkillFileEntry[]> {
  try {
    return await context.files.listEntries(directory)
  } catch (error) {
    // 没有这个根很正常,大多数项目里只有一两种工具
    context.logger.warn({ path: directory, errorMessage: errorMessage(error) }, '读取技能目录失败,已跳过')
    return []
  }
}

function joinRelative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name
}

function parentOf(filePath: string): string {
  const index = filePath.lastIndexOf('/')
  return index === -1 ? '' : filePath.slice(0, index)
}

function relativeOf(rootDirectory: string, filePath: string): string {
  const directory = parentOf(filePath)
  if (!directory) return ''
  if (directory === rootDirectory) return ''
  return directory.slice(rootDirectory.length + 1)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body)
  return match?.[1]?.trim()
}

function clipDescription(text: string | undefined): string | undefined {
  if (!text) return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  return collapsed.length <= MAX_DESCRIPTION_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DESCRIPTION_CHARS)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
