// src/skills.ts
// 技能 —— 工作区里的技能包,模型按名字加载。
//
// 正文不进系统提示词,只列名字和描述:一个技能动辄几百行,每轮都塞进去会挤掉对话。
// 模型判断任务对得上时调 load_skill 取全文,再按正文去读附件。
// 技能和附件都在工作区内,read_file 直接读得到,沙箱不用为它开口子。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { splitFrontmatter } from './frontmatter.ts'
import { createPathGuard, type PathGuard } from './pathGuard.ts'

export type SkillSource = 'grass' | 'cursor' | 'claude' | 'kiro' | 'opencode'

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
const MAX_WALK_DEPTH = 6
const MAX_DESCRIPTION_CHARS = 200
const SKILL_FILE_NAME = 'skill.md'

// 文件里出现 NUL 说明是二进制,不能当技能正文。用码点写,免得源码里出现不可见字符。
const NUL_CHARACTER = String.fromCharCode(0)

const noopLog: SkillLog = { warn() {}, info() {} }

/**
 * 扫出工作区里的全部技能。识别失败不抛错——技能是锦上添花,不能挡启动。
 */
export async function discoverSkills(
  workspace: string,
  logger: SkillLog = noopLog,
): Promise<SkillCatalog> {
  let pathGuard: PathGuard
  try {
    pathGuard = await createPathGuard(workspace)
  } catch (error) {
    logger.warn({ errorMessage: errorMessage(error), workspace }, '工作区无法作为技能扫描根,已跳过')
    return { skills: [], promptSection: '' }
  }

  const skills: Skill[] = []
  const takenNames = new Set<string>()
  for (const root of SKILL_ROOTS) {
    if (skills.length >= MAX_SKILLS) {
      logger.warn({ maxSkills: MAX_SKILLS }, '技能数量到上限,其余不再扫描')
      break
    }
    const rootDirectory = path.join(pathGuard.workspace, root.directory)
    await collectSkillFiles(rootDirectory, rootDirectory, 0, root.source, {
      pathGuard, skills, takenNames, logger,
    })
  }

  skills.sort((left, right) => left.name.localeCompare(right.name))
  logger.info({ skillCount: skills.length }, '技能已识别')
  return { skills, promptSection: renderSkillSection(skills) }
}

export function createSkillRegistry(skills: readonly Skill[]): SkillRegistry {
  const byExactName = new Map(skills.map((skill) => [skill.name, skill]))
  const byLowerCaseName = new Map<string, Skill>()
  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    if (!byLowerCaseName.has(key)) byLowerCaseName.set(key, skill)
  }
  return {
    names: () => skills.map((skill) => skill.name),
    // 模型偶尔会把名字写成 /foo 或大小写不一致,这里兜一下
    find: (name) => {
      const trimmed = name.trim().replace(/^\//, '')
      if (!trimmed) return undefined
      return byExactName.get(trimmed) ?? byLowerCaseName.get(trimmed.toLowerCase())
    },
  }
}

export function renderSkillSection(skills: readonly Skill[]): string {
  if (skills.length === 0) return ''
  return [
    '## 可用技能',
    '下面是打包好的多步流程,正文没有放进上下文。',
    '任务和某条描述对得上时,先调用 load_skill 取全文,再按正文执行;不要凭名字猜步骤。',
    '没被点名、描述也对不上的技能不要用。',
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join('\n')
}

/** load_skill 回给模型的文本:正文 + 附件目录提示。 */
export function formatSkillForModel(skill: Skill): string {
  const lines = [
    `# 技能 ${skill.name}`,
    `正文:${skill.relativePath}`,
    `附件目录:${skill.directoryPath}(脚本、模板、参考文档在这里,用 read_file 按需读,不要整目录读)`,
    '',
    skill.body,
  ]
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
  if (skills.length === 0) return '项目里没有找到技能'
  return `已识别技能 ${skills.length} 个:${skills.map((skill) => skill.name).join('、')}`
}

interface CollectContext {
  pathGuard: PathGuard
  skills: Skill[]
  takenNames: Set<string>
  logger: SkillLog
}

async function collectSkillFiles(
  rootDirectory: string,
  directory: string,
  depth: number,
  source: SkillSource,
  context: CollectContext,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return
  const entries = await readDirectory(directory, context.logger)
  for (const entry of entries) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue
    const child = path.join(directory, entry.name)
    try {
      // 软链必须落回工作区内,否则等于借技能读到工作区外的文件
      if (entry.isSymbolicLink() && !(await context.pathGuard.isInside(child))) {
        context.logger.warn({ path: child }, '符号链接越出工作区,已跳过')
        continue
      }
      const stats = await fs.stat(child)
      if (stats.isDirectory()) {
        await collectSkillFiles(rootDirectory, child, depth + 1, source, context)
        continue
      }
      if (!stats.isFile() || entry.name.toLowerCase() !== SKILL_FILE_NAME) continue
      await loadSkill(child, rootDirectory, source, context)
    } catch (error) {
      context.logger.warn({ path: child, errorMessage: errorMessage(error) }, '技能文件读取失败,已跳过')
    }
  }
}

async function loadSkill(
  filePath: string,
  rootDirectory: string,
  source: SkillSource,
  context: CollectContext,
): Promise<void> {
  const text = await readSkillText(filePath, context)
  if (text === undefined) return

  const { data, body } = splitFrontmatter(text)
  // 没写 name 就用它在技能根下的目录名,允许多级,比如 "review/pr"
  const directoryName = toPosixRelative(rootDirectory, path.dirname(filePath))
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
  if (context.takenNames.has(name)) {
    context.logger.warn({ path: filePath, name }, '技能名重复,保留先扫到的那个')
    return
  }
  const normalizedBody = body.replaceAll(NUL_CHARACTER, '').trim()
  if (!normalizedBody) {
    context.logger.warn({ path: filePath, name }, '技能正文是空的,已跳过')
    return
  }

  const truncated = normalizedBody.length > MAX_SKILL_BODY_CHARS
  context.takenNames.add(name)
  context.skills.push({
    name,
    description,
    relativePath: toPosixRelative(context.pathGuard.workspace, filePath),
    directoryPath: toPosixRelative(context.pathGuard.workspace, path.dirname(filePath)),
    body: truncated ? normalizedBody.slice(0, MAX_SKILL_BODY_CHARS) : normalizedBody,
    truncated,
    source,
  })
}

async function readSkillText(filePath: string, context: CollectContext): Promise<string | undefined> {
  let realPath: string
  try {
    realPath = await context.pathGuard.resolve(filePath)
  } catch (error) {
    context.logger.warn({ path: filePath, errorMessage: errorMessage(error) }, '技能路径越出工作区,已跳过')
    return undefined
  }
  const stats = await fs.stat(realPath)
  if (stats.size > MAX_SKILL_BYTES) {
    context.logger.warn({ path: filePath, size: stats.size }, '技能文件过大,已跳过')
    return undefined
  }
  const text = await fs.readFile(realPath, 'utf8')
  if (text.includes(NUL_CHARACTER)) {
    context.logger.warn({ path: filePath }, '技能文件不是文本,已跳过')
    return undefined
  }
  return text
}

async function readDirectory(directory: string, logger: SkillLog): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 没有这个根很正常,大多数项目里只有一两种工具
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    logger.warn({ path: directory, errorMessage: errorMessage(error) }, '读取技能目录失败,已跳过')
    return []
  }
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

function toPosixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}