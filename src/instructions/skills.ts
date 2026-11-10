// src/instructions/skills.ts
// 技能 —— 工作区里的技能包,模型按名字加载。
//
// 正文不进系统提示词,只列名字和描述:一个技能动辄几百行,每轮都塞进去会挤掉对话。
// 模型判断任务对得上时调 load_skill 取全文,再按正文去读附件。
//
// 技能从「执行世界」里读,本地和远程走同一套扫描逻辑:
// 远程世界里的文件在另一台机器上,本机 fs 读不到。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ExecutionWorld } from '../world/executionWorld.ts'
import { splitFrontmatter, type FrontmatterValue } from '../core/frontmatter.ts'
import { parseJson } from '../core/jsonSafety.ts'
import { createPathGuard, type PathGuard } from '../core/pathGuard.ts'

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
  /** 描述被截断过。索引里要标出来,不然模型以为描述就这么长。 */
  descriptionClipped: boolean
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
  /** 正文的二级标题和它们在文件里的行号。正文被截断时靠它定位。 */
  headings: SkillHeading[]
  /** 因为环境不匹配被跳过时的原因。跳过的技能不进索引。 */
  skippedReason?: string
}

/** 技能正文里的一个标题。行号是 SKILL.md 文件里的行号,read_file 对得上。 */
export interface SkillHeading {
  title: string
  line: number
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

/**
 * 技能扫描的缓存。
 *
 * 按文件的大小和修改时间判断有没有变过——变了就得重读。
 * 缓存文件在工作区的 .grass/tmp 下,模型能改它,所以读的时候要当不可信输入校验。
 */
export interface SkillCache {
  /** 先把缓存读进来。必须在扫描之前调,否则命中不了。 */
  load(): Promise<void>
  /** 取缓存。文件变了或者没有缓存都返回 undefined */
  get(relativePath: string, size?: number, mtimeMs?: number): Skill | undefined
  /** 存缓存 */
  set(relativePath: string, size: number | undefined, mtimeMs: number | undefined, skill: Skill): void
  /** 落盘。失败不影响本次使用 */
  flush(): Promise<void>
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

// 缓存文件的格式版本。解析不了或版本对不上就当没有缓存。
const CACHE_VERSION = 1

/** 缓存文件在工作区里的位置。放在 .grass/tmp 下,那目录已经在 .gitignore 里。 */
export const SKILL_CACHE_RELATIVE_PATH = '.grass/tmp/skills-cache.json'

// GrassAgent 跑在本地终端上。技能声明别的环境就装不进来。
const GRASS_ENVIRONMENT = 'local'
const GRASS_SURFACE = 'cli'

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
 * 扫描缓存。放在 .grass/tmp 下,那目录已经在 .gitignore 里。
 *
 * 只缓存「文件没变」的情况:大小和修改时间都对得上才复用。
 * 缓存文件模型也能写,所以读的时候按不可信输入处理,结构对不上就当没有缓存。
 */
export function createSkillCache(options: {
  /** 工作区根目录 */
  workspace: string
  /** 缓存文件在工作区里的相对路径 */
  relativePath: string
  logger?: SkillLog
}): SkillCache {
  const logger = options.logger ?? noopLog
  const entries = new Map<string, CacheEntry>()
  const filePath = path.join(options.workspace, options.relativePath)

  return {
    async load(): Promise<void> {
      let text: string
      try {
        text = await fs.readFile(filePath, 'utf8')
      } catch {
        // 没有缓存是正常情况,第一次扫描完就有了
        return
      }
      for (const entry of parseCache(text)) entries.set(entry.path, entry)
    },
    get(relativePath, size, mtimeMs) {
      const entry = entries.get(relativePath)
      if (!entry) return undefined
      if (entry.size !== size || entry.mtimeMs !== mtimeMs) return undefined
      return entry.skill
    },
    set(relativePath, size, mtimeMs, skill) {
      entries.set(relativePath, { path: relativePath, size, mtimeMs, skill })
    },
    async flush(): Promise<void> {
      const payload = {
        version: CACHE_VERSION,
        entries: [...entries.values()],
      }
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, JSON.stringify(payload), 'utf8')
      } catch (error) {
        logger.warn({ path: filePath, errorMessage: errorMessage(error) }, '技能缓存写入失败,已忽略')
      }
    },
  }
}

interface CacheEntry {
  path: string
  size: number | undefined
  mtimeMs: number | undefined
  skill: Skill
}

function parseCache(text: string): CacheEntry[] {
  try {
    const parsed = parseJson(text) as { version?: unknown; entries?: unknown }
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return []
    const result: CacheEntry[] = []
    for (const raw of parsed.entries) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      if (typeof entry.path !== 'string' || !entry.skill || typeof entry.skill !== 'object') continue
      const skill = entry.skill as unknown as Skill
      if (typeof skill.name !== 'string' || typeof skill.body !== 'string') continue
      result.push({
        path: entry.path,
        size: typeof entry.size === 'number' ? entry.size : undefined,
        mtimeMs: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : undefined,
        skill,
      })
    }
    return result
  } catch (error) {
    // 缓存坏了就当没有,不能因为它挡启动
    return []
  }
}

/**
 * 扫出工作区里的全部技能。识别失败不抛错——技能是锦上添花,不能挡启动。
 */
export async function discoverSkills(options: {
  files: SkillFileSystem
  origin: SkillOrigin
  logger?: SkillLog
  /** 给了就用缓存,省掉重复读文件和解析 */
  cache?: SkillCache
}): Promise<SkillCatalog> {
  const logger = options.logger ?? noopLog
  const collected: Skill[] = []
  const maxDepth = options.origin.kind === 'remote' ? REMOTE_WALK_DEPTH : LOCAL_WALK_DEPTH

  await options.cache?.load()

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
      cache: options.cache,
      logger,
    })
  }

  // 同名技能全部禁用:挑一个留下的话,用户改到哪份都没法确定自己用的是哪份。
  // 全部禁用并告警,让人自己决定留哪一份。
  const skills = disableDuplicatedSkills(collected, logger)

  skills.sort((left, right) => left.name.localeCompare(right.name))
  await options.cache?.flush()
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

/** 技能能不能用。禁用、只读、环境不匹配都算不能用。 */
function isUsableSkill(skill: Skill): boolean {
  return !skill.disabledReason && !skill.skippedReason
}

export function createSkillRegistry(skills: readonly Skill[]): SkillRegistry {
  // 被禁用的技能不进注册表:模型问 load_skill 时找不到它,就不会拿一份来路不明的正文。
  // 只允许用户手敲的技能同样不进——模型不能自己调它们。
  const usable = skills.filter((skill) => isUsableSkill(skill) && !skill.commandOnly)
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
  const usable = skills.filter((skill) => isUsableSkill(skill) && !skill.commandOnly)
  if (usable.length === 0) return ''
  return [
    '## 可用技能',
    '下面是打包好的多步流程,正文没有放进上下文。',
    '任务和某条描述对得上时,先调用 load_skill 取全文,再按正文执行;不要凭名字猜步骤。',
    '没被点名、描述也对不上的技能不要用。',
    ...usable.map((skill) => (
      `- ${skill.name}(来源:${skill.origin.label}): ${skill.description}` +
      `${skill.descriptionClipped ? '(描述已截断)' : ''}`
    )),
  ].join('\n')
}

/** 被禁用的技能和原因。启动时打给用户看,免得技能凭空消失。 */
export function describeDisabledSkills(skills: readonly Skill[]): string[] {
  return skills
    .filter((skill) => skill.disabledReason)
    .map((skill) => `技能 ${skill.name} 已禁用:${skill.disabledReason}`)
}

/** 因为环境不匹配被跳过的技能。 */
export function describeSkippedSkills(skills: readonly Skill[]): string[] {
  return skills
    .filter((skill) => skill.skippedReason)
    .map((skill) => `技能 ${skill.name} 已跳过:${skill.skippedReason}`)
}

/** 技能清单的文字。给 /skills 用。 */
export function formatSkillList(skills: readonly Skill[]): string {
  if (skills.length === 0) return '项目里没有找到技能'
  const lines: string[] = [`共 ${skills.length} 个技能:`]
  for (const skill of skills) {
    const state = skill.disabledReason
      ? '已禁用'
      : skill.skippedReason
        ? '已跳过'
        : skill.commandOnly
          ? '仅命令'
          : '可用'
    const detail = skill.disabledReason ?? skill.skippedReason ?? skill.description
    lines.push(`- ${skill.name}(${state},来源:${skill.origin.label}): ${detail}`)
    lines.push(`  ${skill.relativePath}`)
  }
  return lines.join('\n')
}

/**
 * 只允许用户手敲的技能。 */
export function commandOnlySkills(skills: readonly Skill[]): Skill[] {
  return skills.filter((skill) => isUsableSkill(skill) && skill.commandOnly)
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
    `正文里的相对路径都相对于 ${skill.directoryPath},不是工作区根目录。`,
  ]
  if (skill.attachments.length > 0) {
    lines.push(`附件:${skill.attachments.join('、')}`)
  }
  if (skill.headings.length > 0) {
    lines.push('目录:')
    for (const heading of skill.headings) lines.push(`- ${heading.title}(第 ${heading.line} 行)`)
  }
  lines.push('', skill.body)
  if (skill.truncated) {
    lines.push(
      '',
      '---',
      `正文超过 ${MAX_SKILL_BODY_CHARS} 字已截断,上面的目录覆盖全文,` +
      `用 read_file 读 ${skill.relativePath} 的对应段落。`,
    )
  }
  return lines.join('\n')
}

export function summarizeSkills(skills: readonly Skill[]): string {
  const usable = skills.filter((skill) => isUsableSkill(skill))
  const disabled = skills.filter((skill) => skill.disabledReason).length
  const skipped = skills.filter((skill) => skill.skippedReason).length
  if (usable.length === 0) {
    if (disabled > 0 || skipped > 0) return `技能都不可用(禁用 ${disabled} 个,跳过 ${skipped} 个)`
    return '项目里没有找到技能'
  }
  const notes: string[] = []
  if (disabled > 0) notes.push(`${disabled} 个同名冲突被禁用`)
  if (skipped > 0) notes.push(`${skipped} 个环境不匹配被跳过`)
  const suffix = notes.length > 0 ? `,另有${notes.join('、')}` : ''
  return `已识别技能 ${usable.length} 个:${usable.map((skill) => skill.name).join('、')}${suffix}`
}

interface CollectContext {
  files: SkillFileSystem
  origin: SkillOrigin
  maxDepth: number
  skills: Skill[]
  cache?: SkillCache
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
    await loadSkill(child, rootDirectory, source, entry.size, entry.mtimeMs, context)
  }
}

async function loadSkill(
  filePath: string,
  rootDirectory: string,
  source: SkillSource,
  size: number | undefined,
  mtimeMs: number | undefined,
  context: CollectContext,
): Promise<void> {
  // 文件没变就用缓存,省掉读文件和解析
  const cached = context.cache?.get(filePath, size, mtimeMs)
  if (cached) {
    context.skills.push(cached)
    return
  }

  const text = await context.files.readText(filePath)
  if (text === undefined) {
    context.logger.warn({ path: filePath }, '技能文件读不到或不是文本,已跳过')
    return
  }

  const { data, body, bodyStartLine } = splitFrontmatter(text)
  // 没写 name 就用它在技能根下的目录名,允许多级,比如 "review/pr"
  const directoryName = relativeOf(rootDirectory, filePath)
  const name = (stringValue(data.name) ?? directoryName).trim()
  const clipped = clipDescription(stringValue(data.description) ?? firstHeading(body))
  const description = clipped?.text
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
  // 环境不匹配的技能仍然收进来,但标记成跳过。
  // 这样 /skills 还能看到它存在过,不至于凭空消失。
  const skippedReason = checkEnvironment(data)
  if (skippedReason) {
    context.logger.warn({ path: filePath, name, reason: skippedReason }, '技能环境不匹配,已跳过')
  }
  context.skills.push({
    name,
    description,
    descriptionClipped: clipped?.clipped ?? false,
    relativePath: filePath,
    directoryPath: parentOf(filePath),
    body: truncated ? normalizedBody.slice(0, MAX_SKILL_BODY_CHARS) : normalizedBody,
    truncated,
    source,
    origin: context.origin,
    commandOnly: isCommandOnly(data),
    attachments,
    headings: collectHeadings(normalizedBody, bodyStartLine),
    skippedReason,
  })
  context.cache?.set(filePath, size, mtimeMs, context.skills[context.skills.length - 1]!)
}

/**
 * 环境是否匹配。
 *
 * GrassAgent 跑在本地终端上,所以运行环境算 local,界面算 cli。
 * 技能声明了别的环境就别装进来——云端专用的技能在这里跑不了。
 */
function checkEnvironment(data: Record<string, FrontmatterValue>): string | undefined {
  const environments = stringListOf(data.environments)
  if (environments.length > 0 && !environments.includes(GRASS_ENVIRONMENT)) {
    return `只在 ${environments.join('、')} 环境可用`
  }
  const disabledEnvironments = stringListOf(data['disabled-environments'])
  if (disabledEnvironments.includes(GRASS_ENVIRONMENT)) {
    return `${GRASS_ENVIRONMENT} 环境被显式禁用`
  }
  const surfaces = stringListOf(nestedValue(data, 'surfaces'))
  if (surfaces.length > 0 && !surfaces.includes(GRASS_SURFACE)) {
    return `只在 ${surfaces.join('、')} 界面可用`
  }
  return undefined
}

function stringListOf(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function nestedValue(data: Record<string, FrontmatterValue>, key: string): FrontmatterValue | undefined {
  const mapping = data.metadata
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return undefined
  return mapping[key]
}

/**
 * 正文里的二级标题和它们的文件行号。
 *
 * 正文被截断时,模型靠这份清单用 read_file 去读缺掉的那一段。
 * 行号按整个 SKILL.md 算,read_file 给的行号才对得上。
 */
function collectHeadings(body: string, bodyStartLine: number): SkillHeading[] {
  const headings: SkillHeading[] = []
  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = /^##\s+(.+)$/.exec(lines[index] ?? '')
    if (!match) continue
    headings.push({ title: match[1].trim(), line: bodyStartLine + index })
  }
  return headings
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

function clipDescription(text: string | undefined): { text: string; clipped: boolean } | undefined {
  if (!text) return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  if (collapsed.length <= MAX_DESCRIPTION_CHARS) return { text: collapsed, clipped: false }
  // 在句子边界截断。切在句子中间,后半句多半正是触发词所在的地方。
  const head = collapsed.slice(0, MAX_DESCRIPTION_CHARS)
  const boundary = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('.'), head.lastIndexOf('；'),
    head.lastIndexOf(';'), head.lastIndexOf('，'), head.lastIndexOf(','),
  )
  const cut = boundary > MAX_DESCRIPTION_CHARS * 0.6 ? head.slice(0, boundary + 1) : head
  return { text: `${cut}…`, clipped: true }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
