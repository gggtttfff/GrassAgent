// src/projectInstructions.ts
// 项目规则 —— 认出仓库里 opencode、cursor、claude、kiro 留下的规则和提示词。
//
// 始终生效的规则放进系统提示词,否则模型看不见项目约定。
// 按文件生效的规则、以及命令/技能/角色提示词只列索引:
// 整篇塞进去会占满上下文,提示词没被点名也不该自动执行。
// 模型要用时走 read_file。远程 URL 不抓取,工作区外的路径和软链不读。

import { promises as fs } from 'node:fs'
import { glob } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { JsonSafetyError, parseJson } from './jsonSafety.ts'
import { createPathGuard, type PathGuard } from './pathGuard.ts'

export type InstructionTool = 'opencode' | 'cursor' | 'claude' | 'kiro'
export type InstructionKind = 'rule' | 'prompt'
export type InstructionActivation = 'always' | 'file-match' | 'intelligent' | 'manual'

export interface ProjectInstruction {
  /** 工作区内的相对路径,用 / 分隔 */
  relativePath: string
  tools: InstructionTool[]
  kind: InstructionKind
  activation: InstructionActivation
  /** 命令名、技能名或文件名 */
  title: string
  description?: string
  patterns: string[]
  /** 放进系统提示词的正文。索引项没有这一段。 */
  includedBody?: string
  /** 正文没放进去的原因,给索引行用 */
  omittedReason?: string
}

export interface InstructionCatalog {
  instructions: ProjectInstruction[]
  /** 拼到系统提示词后面的段落。没有可识别文件时是空字符串。 */
  promptSection: string
}

export interface InstructionLog {
  warn(object: object, message: string): void
  info(object: object, message: string): void
}

const TOOL_ORDER: readonly InstructionTool[] = ['opencode', 'cursor', 'claude', 'kiro']

const SKIP_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  'vendor', 'target', '.turbo', '.cache', '__pycache__',
])

const SHARED_FILE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'])

const OPENCODE_CONFIG_FILES = [
  'opencode.jsonc',
  'opencode.json',
  '.opencode/opencode.jsonc',
  '.opencode/opencode.json',
]

// 单文件太大就不要整篇塞进每轮请求。索引里仍能看到路径。
const MAX_FILE_BYTES = 256 * 1024
const MAX_INCLUDED_BODY_CHARS = 12_000
const MAX_INCLUDED_TOTAL_CHARS = 24_000
const MAX_WALK_DEPTH = 8
const MAX_DIRECTORIES = 2_000
const MAX_INSTRUCTIONS = 300
const MAX_INSTRUCTION_MATCHES = 30
const MAX_DESCRIPTION_CHARS = 160

const noopLog: InstructionLog = { warn() {}, info() {} }

interface Draft {
  realPath: string
  relativePath: string
  tools: Set<InstructionTool>
  kind: InstructionKind
  activation: InstructionActivation
  title: string
  description?: string
  patterns: string[]
  bodyText?: string
}

type FrontmatterValue = string | boolean | string[]

export function appendProjectInstructions(systemPrompt: string, section: string): string {
  if (!section) return systemPrompt
  return `${systemPrompt}\n\n${section}`
}

export function summarizeInstructions(instructions: readonly ProjectInstruction[]): string {
  if (instructions.length === 0) {
    return '项目里没有识别到 opencode、cursor、claude、kiro 的规则或提示词'
  }
  const rules = instructions.filter((item) => item.kind === 'rule').length
  const prompts = instructions.length - rules
  const counts = TOOL_ORDER
    .map((tool) => `${tool} ${instructions.filter((item) => item.tools.includes(tool)).length}`)
    .join('、')
  return `已识别规则 ${rules} 条、提示词 ${prompts} 条（${counts}）`
}

export function formatInstructionReport(instructions: readonly ProjectInstruction[]): string {
  const summary = summarizeInstructions(instructions)
  if (instructions.length === 0) return summary
  return `${summary}\n${instructions.map(formatIndexLine).join('\n')}`
}

export async function discoverProjectInstructions(
  workspace: string,
  logger: InstructionLog = noopLog,
): Promise<InstructionCatalog> {
  let pathGuard: PathGuard
  try {
    pathGuard = await createPathGuard(workspace)
  } catch (error) {
    logger.warn({ errorMessage: errorMessage(error), workspace }, '工作区无法作为规则扫描根,已跳过')
    return emptyCatalog()
  }

  const drafts = new Map<string, Draft>()
  const state = { directories: 0, truncated: false }
  await collectSharedMarkdown(pathGuard, drafts, state, logger)
  await addCursorLegacyRules(pathGuard, drafts, state, logger)
  await collectCursor(pathGuard, drafts, state, logger)
  await collectClaude(pathGuard, drafts, state, logger)
  await collectKiro(pathGuard, drafts, state, logger)
  await collectOpenCode(pathGuard, drafts, state, logger)

  const instructions = materialize(drafts)
  logger.info({
    ruleCount: instructions.filter((item) => item.kind === 'rule').length,
    promptCount: instructions.filter((item) => item.kind === 'prompt').length,
  }, '项目规则和提示词已识别')
  return { instructions, promptSection: renderInstructionSection(instructions) }
}

function emptyCatalog(): InstructionCatalog {
  return { instructions: [], promptSection: '' }
}

async function collectSharedMarkdown(
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  await walk(pathGuard.workspace, 0, pathGuard, state, logger, async (filePath, name) => {
    if (!SHARED_FILE_NAMES.has(name)) return
    const text = await readProjectText(filePath, pathGuard, logger)
    if (text === undefined) return
    const relativePath = await relativeProjectPath(pathGuard, filePath)
    const classified = classifySharedFile(relativePath, text)
    if (!classified) return
    await remember(drafts, pathGuard, filePath, classified, logger, state)
  })
}

function classifySharedFile(relativePath: string, text: string): Omit<Draft, 'realPath' | 'relativePath'> | undefined {
  const name = posixBasename(relativePath)
  if (name === 'AGENTS.md') {
    return sharedRule(relativePath, text, ['opencode', 'cursor', 'claude', 'kiro'], 'AGENTS.md')
  }
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') {
    const projectAlways = relativePath === 'CLAUDE.md'
      || relativePath === 'CLAUDE.local.md'
      || relativePath === '.claude/CLAUDE.md'
    return sharedRule(relativePath, text, ['claude'], name, projectAlways)
  }
  return undefined
}

function sharedRule(
  relativePath: string,
  text: string,
  tools: InstructionTool[],
  title: string,
  projectAlways = relativePath === 'AGENTS.md',
): Omit<Draft, 'realPath' | 'relativePath'> {
  const { body } = splitFrontmatter(text)
  if (projectAlways) {
    return {
      tools: new Set(tools),
      kind: 'rule',
      activation: 'always',
      title,
      patterns: [],
      bodyText: body,
    }
  }
  const directory = posixDirname(relativePath)
  return {
    tools: new Set(tools),
    kind: 'rule',
    activation: 'file-match',
    title,
    description: `在 ${directory} 下工作时生效`,
    patterns: [`${directory}/**`],
    bodyText: body,
  }
}

async function addCursorLegacyRules(
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  const filePath = path.join(pathGuard.workspace, '.cursorrules')
  const text = await readProjectText(filePath, pathGuard, logger, { missingOk: true })
  if (!text) return
  await remember(drafts, pathGuard, filePath, {
    tools: new Set<InstructionTool>(['cursor']),
    kind: 'rule',
    activation: 'always',
    title: '.cursorrules',
    patterns: [],
    bodyText: text,
  }, logger, state)
}

async function collectCursor(
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  const rulesRoot = path.join(pathGuard.workspace, '.cursor', 'rules')
  await collectUnder(rulesRoot, pathGuard, state, logger, (relativePath) => relativePath.endsWith('.mdc'), async (filePath) => {
    const text = await readProjectText(filePath, pathGuard, logger)
    if (text === undefined) return
    const { data, body } = splitFrontmatter(text)
    const activation = cursorActivation(data)
    await remember(drafts, pathGuard, filePath, {
      tools: new Set(['cursor']),
      kind: 'rule',
      activation,
      title: stringValue(data.name) ?? posixBasename(filePath),
      description: clip(stringValue(data.description)),
      patterns: activation === 'file-match' ? stringList(data.globs) : [],
      bodyText: body,
    }, logger, state)
  })

  const commandsRoot = path.join(pathGuard.workspace, '.cursor', 'commands')
  await collectPromptFiles(commandsRoot, pathGuard, drafts, state, logger, 'cursor', 'command')
  await collectSkillFiles(path.join(pathGuard.workspace, '.cursor', 'skills'), pathGuard, drafts, state, logger, 'cursor')
}

function cursorActivation(data: Record<string, FrontmatterValue>): InstructionActivation {
  if (data.alwaysApply === true) return 'always'
  if (stringList(data.globs).length > 0) return 'file-match'
  if (stringValue(data.description)) return 'intelligent'
  return 'manual'
}

async function collectClaude(
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  const claudeRoot = path.join(pathGuard.workspace, '.claude')
  const projectMemory = path.join(claudeRoot, 'CLAUDE.md')
  const memoryText = await readProjectText(projectMemory, pathGuard, logger, { missingOk: true })
  if (memoryText) {
    const classified = classifySharedFile('.claude/CLAUDE.md', memoryText)
    if (classified) await remember(drafts, pathGuard, projectMemory, classified, logger, state)
  }

  await collectUnder(
    path.join(claudeRoot, 'rules'),
    pathGuard,
    state,
    logger,
    (relativePath) => relativePath.endsWith('.md'),
    async (filePath) => {
      const text = await readProjectText(filePath, pathGuard, logger)
      if (text === undefined) return
      const { data, body } = splitFrontmatter(text)
      const patterns = stringList(data.paths)
      await remember(drafts, pathGuard, filePath, {
        tools: new Set(['claude']),
        kind: 'rule',
        activation: patterns.length > 0 ? 'file-match' : 'always',
        title: stringValue(data.name) ?? posixBasename(filePath),
        description: clip(stringValue(data.description)),
        patterns,
        bodyText: body,
      }, logger, state)
    },
  )

  await collectPromptFiles(path.join(claudeRoot, 'commands'), pathGuard, drafts, state, logger, 'claude', 'command')
  await collectPromptFiles(path.join(claudeRoot, 'agents'), pathGuard, drafts, state, logger, 'claude', 'agent')
  await collectPromptFiles(path.join(claudeRoot, 'output-styles'), pathGuard, drafts, state, logger, 'claude', 'style')
  await collectSkillFiles(path.join(claudeRoot, 'skills'), pathGuard, drafts, state, logger, 'claude')
}

async function collectKiro(
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  const kiroRoot = path.join(pathGuard.workspace, '.kiro')
  await collectUnder(
    path.join(kiroRoot, 'steering'),
    pathGuard,
    state,
    logger,
    (relativePath) => relativePath.endsWith('.md'),
    async (filePath) => {
      const text = await readProjectText(filePath, pathGuard, logger)
      if (text === undefined) return
      const { data, body } = splitFrontmatter(text)
      const activation = kiroActivation(data, logger, filePath)
      const patterns = activation === 'file-match'
        ? [...stringList(data.fileMatchPattern), ...stringList(data.fileMatch)]
        : []
      await remember(drafts, pathGuard, filePath, {
        tools: new Set(['kiro']),
        kind: 'rule',
        activation,
        title: stringValue(data.name) ?? posixBasename(filePath),
        description: clip(stringValue(data.description) ?? firstHeading(body)),
        patterns,
        bodyText: body,
      }, logger, state)
    },
  )

  await collectPromptFiles(path.join(kiroRoot, 'agents'), pathGuard, drafts, state, logger, 'kiro', 'agent')
  await collectSkillFiles(path.join(kiroRoot, 'skills'), pathGuard, drafts, state, logger, 'kiro')
  await collectKiroAgentJson(path.join(kiroRoot, 'agents'), pathGuard, drafts, state, logger)
}

function kiroActivation(
  data: Record<string, FrontmatterValue>,
  logger: InstructionLog,
  filePath: string,
): InstructionActivation {
  const inclusion = stringValue(data.inclusion)?.toLowerCase()
  if (!inclusion || inclusion === 'always') return 'always'
  if (inclusion === 'filematch' || inclusion === 'file_match') return 'file-match'
  if (inclusion === 'manual') return 'manual'
  if (inclusion === 'auto') return 'intelligent'
  logger.warn({ path: filePath, inclusion }, '不认识的 Kiro inclusion,按点名才用处理')
  return 'manual'
}

async function collectKiroAgentJson(
  directory: string,
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  await collectUnder(directory, pathGuard, state, logger, (relativePath) => relativePath.endsWith('.json'), async (filePath) => {
    const text = await readProjectText(filePath, pathGuard, logger)
    if (text === undefined) return
    let parsed: unknown
    try {
      parsed = parseJson(text)
    } catch (error) {
      logger.warn(
        { path: filePath, errorMessage: errorMessage(error) },
        error instanceof JsonSafetyError ? `${error.message},已跳过` : 'Kiro 代理配置不是合法 JSON,已跳过',
      )
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const agent = parsed as Record<string, unknown>
    const prompt = typeof agent.prompt === 'string' ? agent.prompt : ''
    const description = typeof agent.description === 'string' ? agent.description : undefined
    const pointedFile = promptFileHint(prompt)
    await remember(drafts, pathGuard, filePath, {
      tools: new Set(['kiro']),
      kind: 'prompt',
      activation: 'manual',
      title: typeof agent.name === 'string' && agent.name.trim()
        ? agent.name.trim()
        : posixBasename(filePath).replace(/\.json$/i, ''),
      description: clip(pointedFile ? `${description ?? '代理提示词'} → ${pointedFile}` : description),
      patterns: [],
    }, logger, state)
  })
}

async function collectOpenCode(
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  const openCodeRoot = path.join(pathGuard.workspace, '.opencode')
  await collectPromptFiles(path.join(openCodeRoot, 'commands'), pathGuard, drafts, state, logger, 'opencode', 'command')
  await collectPromptFiles(path.join(openCodeRoot, 'command'), pathGuard, drafts, state, logger, 'opencode', 'command')
  await collectPromptFiles(path.join(openCodeRoot, 'agents'), pathGuard, drafts, state, logger, 'opencode', 'agent')
  await collectPromptFiles(path.join(openCodeRoot, 'agent'), pathGuard, drafts, state, logger, 'opencode', 'agent')
  await collectSkillFiles(path.join(openCodeRoot, 'skills'), pathGuard, drafts, state, logger, 'opencode')

  for (const relativeConfig of OPENCODE_CONFIG_FILES) {
    const filePath = path.join(pathGuard.workspace, relativeConfig)
    const text = await readProjectText(filePath, pathGuard, logger, { missingOk: true })
    if (!text) continue
    await readOpenCodeConfig(filePath, text, pathGuard, drafts, state, logger)
  }
}

async function readOpenCodeConfig(
  filePath: string,
  text: string,
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  let parsed: unknown
  try {
    // 先去掉注释再量深度。注释里的括号不能算进嵌套,否则一份正常配置会被误伤。
    parsed = parseJson(stripJsonComments(text))
  } catch (error) {
    logger.warn(
      { path: filePath, errorMessage: errorMessage(error) },
      error instanceof JsonSafetyError ? `${error.message},已跳过` : 'OpenCode 配置不是合法 JSON,已跳过',
    )
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const config = parsed as Record<string, unknown>
  const relativeConfig = await relativeProjectPath(pathGuard, filePath)

  const instructionPatterns = stringListFromUnknown(config.instructions)
  for (const pattern of instructionPatterns) {
    const matches = await expandInstructionPattern(pattern, pathGuard, logger)
    for (const match of matches) {
      const body = await readProjectText(match, pathGuard, logger)
      if (body === undefined) continue
      const { body: withoutFrontmatter } = splitFrontmatter(body)
      await remember(drafts, pathGuard, match, {
        tools: new Set(['opencode']),
        kind: 'rule',
        activation: 'always',
        title: posixBasename(match),
        patterns: [],
        bodyText: withoutFrontmatter,
      }, logger, state)
    }
  }

  await rememberInlinePrompts(config.command, relativeConfig, '命令', drafts, pathGuard, filePath, state, logger)
  await rememberInlinePrompts(config.commands, relativeConfig, '命令', drafts, pathGuard, filePath, state, logger)
  await rememberInlinePrompts(config.agents, relativeConfig, '代理', drafts, pathGuard, filePath, state, logger)
  if (config.agent && typeof config.agent === 'object' && !Array.isArray(config.agent)) {
    const agent = config.agent as Record<string, unknown>
    if (firstString(agent.template, agent.system, agent.prompt)) {
      await remember(drafts, pathGuard, filePath, {
        tools: new Set<InstructionTool>(['opencode']),
        kind: 'prompt',
        activation: 'manual',
        title: typeof agent.name === 'string' && agent.name.trim() ? `/${agent.name.trim()}` : '/agent',
        description: clip(typeof agent.description === 'string' ? `代理 ${agent.description}` : '代理'),
        patterns: [],
        realPath: `${filePath}#agent`,
        relativePath: relativeConfig,
      }, logger, state)
    } else {
      await rememberInlinePrompts(agent, relativeConfig, '代理', drafts, pathGuard, filePath, state, logger)
    }
  }
}

async function rememberInlinePrompts(
  value: unknown,
  relativeConfig: string,
  label: string,
  drafts: Map<string, Draft>,
  pathGuard: PathGuard,
  filePath: string,
  state: ScanState,
  logger: InstructionLog,
): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const template = firstString(entry.template, entry.system, entry.prompt)
    if (!template) continue
    const description = typeof entry.description === 'string' ? entry.description : undefined
    // realPath 带上名字,同一份配置里的多条提示词才不会互相覆盖。
    // 给模型看的路径仍是配置文件本身,read_file 打得开。
    await remember(drafts, pathGuard, filePath, {
      tools: new Set<InstructionTool>(['opencode']),
      kind: 'prompt',
      activation: 'manual',
      title: `/${name}`,
      description: clip(`${label} ${description ?? ''}`.trim()),
      patterns: [],
      realPath: `${filePath}#${name}`,
      relativePath: relativeConfig,
    }, logger, state)
  }
}

async function collectPromptFiles(
  directory: string,
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
  tool: InstructionTool,
  flavor: 'command' | 'agent' | 'style',
): Promise<void> {
  await collectUnder(directory, pathGuard, state, logger, (relativePath) => relativePath.endsWith('.md'), async (filePath) => {
    const text = await readProjectText(filePath, pathGuard, logger)
    if (text === undefined) return
    const { data, body } = splitFrontmatter(text)
    const nested = path.relative(directory, filePath).replaceAll(path.sep, '/').replace(/\.md$/i, '')
    const title = flavor === 'command'
      ? `/${nested}`
      : (stringValue(data.name) ?? nested)
    await remember(drafts, pathGuard, filePath, {
      tools: new Set([tool]),
      kind: 'prompt',
      activation: 'manual',
      title,
      description: clip(stringValue(data.description) ?? firstHeading(body)),
      patterns: [],
    }, logger, state)
  })
}

async function collectSkillFiles(
  directory: string,
  pathGuard: PathGuard,
  drafts: Map<string, Draft>,
  state: ScanState,
  logger: InstructionLog,
  tool: InstructionTool,
): Promise<void> {
  await collectUnder(directory, pathGuard, state, logger, (relativePath) => relativePath.endsWith('/SKILL.md') || relativePath === 'SKILL.md', async (filePath) => {
    const text = await readProjectText(filePath, pathGuard, logger)
    if (text === undefined) return
    const { data, body } = splitFrontmatter(text)
    const nested = path.relative(directory, filePath).replaceAll(path.sep, '/').replace(/\/SKILL\.md$/i, '')
    await remember(drafts, pathGuard, filePath, {
      tools: new Set([tool]),
      kind: 'prompt',
      activation: stringValue(data.description) ? 'intelligent' : 'manual',
      title: stringValue(data.name) ?? nested,
      description: clip(stringValue(data.description) ?? firstHeading(body)),
      patterns: [],
    }, logger, state)
  })
}

interface ScanState {
  directories: number
  truncated: boolean
}

async function walk(
  directory: string,
  depth: number,
  pathGuard: PathGuard,
  state: ScanState,
  logger: InstructionLog,
  onFile: (filePath: string, name: string) => Promise<void>,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return
  if (state.directories >= MAX_DIRECTORIES) {
    noteTruncation(state, logger, '目录太多,规则扫描提前停止')
    return
  }
  state.directories++
  const entries = await readDirectory(directory, logger)
  for (const entry of entries) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith('.')) continue
    const child = path.join(directory, entry.name)
    try {
      if (entry.isSymbolicLink()) {
        if (!(await pathGuard.isInside(child))) {
          logger.warn({ path: child }, '路径越出工作区,已跳过')
          continue
        }
        const stats = await fs.stat(child)
        if (stats.isDirectory()) await walk(child, depth + 1, pathGuard, state, logger, onFile)
        else if (stats.isFile()) await onFile(child, entry.name)
        continue
      }
      if (entry.isDirectory()) {
        await walk(child, depth + 1, pathGuard, state, logger, onFile)
        continue
      }
      if (entry.isFile()) await onFile(child, entry.name)
    } catch (error) {
      logger.warn({ path: child, errorMessage: errorMessage(error) }, '规则文件读取失败,已跳过')
    }
  }
}

async function collectUnder(
  directory: string,
  pathGuard: PathGuard,
  state: ScanState,
  logger: InstructionLog,
  accept: (relativePosix: string) => boolean,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  if (!(await pathExists(directory))) return
  if (!(await pathGuard.isInside(directory))) {
    logger.warn({ path: directory }, '路径越出工作区,已跳过')
    return
  }
  await walkToolDirectory(directory, directory, 0, pathGuard, state, logger, accept, onFile)
}

async function walkToolDirectory(
  root: string,
  directory: string,
  depth: number,
  pathGuard: PathGuard,
  state: ScanState,
  logger: InstructionLog,
  accept: (relativePosix: string) => boolean,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return
  if (state.directories >= MAX_DIRECTORIES) {
    noteTruncation(state, logger, '目录太多,规则扫描提前停止')
    return
  }
  state.directories++
  const entries = await readDirectory(directory, logger)
  for (const entry of entries) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue
    const child = path.join(directory, entry.name)
    try {
      if (entry.isSymbolicLink()) {
        if (!(await pathGuard.isInside(child))) {
          logger.warn({ path: child }, '路径越出工作区,已跳过')
          continue
        }
      }
      const directoryEntry = entry.isDirectory() || (entry.isSymbolicLink() && (await fs.stat(child)).isDirectory())
      if (directoryEntry) {
        await walkToolDirectory(root, child, depth + 1, pathGuard, state, logger, accept, onFile)
        continue
      }
      const relativePosix = path.relative(root, child).replaceAll(path.sep, '/')
      if (accept(relativePosix)) await onFile(child)
    } catch (error) {
      logger.warn({ path: child, errorMessage: errorMessage(error) }, '规则文件读取失败,已跳过')
    }
  }
}

async function remember(
  drafts: Map<string, Draft>,
  pathGuard: PathGuard,
  filePath: string,
  incoming: Omit<Draft, 'realPath' | 'relativePath'> & { realPath?: string; relativePath?: string },
  logger: InstructionLog,
  state: ScanState,
): Promise<void> {
  const bodyText = incoming.bodyText?.replace(/\u0000/g, '')
  if (incoming.kind === 'rule' && incoming.activation === 'always' && bodyText !== undefined && !bodyText.trim()) {
    logger.warn({ path: filePath }, '规则文件是空的,已跳过')
    return
  }
  let realPath = incoming.realPath
  let relativePath = incoming.relativePath
  if (!realPath || !relativePath) {
    try {
      realPath = await pathGuard.resolve(filePath)
    } catch (error) {
      logger.warn({ path: filePath, errorMessage: errorMessage(error) }, '路径越出工作区,已跳过')
      return
    }
    relativePath = toPosixRelative(pathGuard.workspace, realPath)
  }
  const draft: Draft = {
    realPath,
    relativePath,
    tools: incoming.tools,
    kind: incoming.kind,
    activation: incoming.activation,
    title: incoming.title,
    description: incoming.description,
    patterns: incoming.patterns,
    bodyText,
  }
  upsert(drafts, draft, state, logger)
}

function upsert(drafts: Map<string, Draft>, incoming: Draft, state: ScanState, logger: InstructionLog): void {
  const existing = drafts.get(incoming.realPath)
  if (!existing) {
    if (drafts.size >= MAX_INSTRUCTIONS) {
      noteTruncation(state, logger, '规则和提示词过多,已截断')
      return
    }
    drafts.set(incoming.realPath, incoming)
    return
  }
  for (const tool of incoming.tools) existing.tools.add(tool)
  const promoteToAlwaysRule = incoming.kind === 'rule' && incoming.activation === 'always'
  if (promoteToAlwaysRule && (existing.kind === 'prompt' || existing.activation !== 'always')) {
    existing.kind = 'rule'
    existing.activation = 'always'
    existing.patterns = []
    existing.bodyText = incoming.bodyText ?? existing.bodyText
    existing.title = incoming.title || existing.title
  }
  if (!existing.description && incoming.description) existing.description = incoming.description
}

function materialize(drafts: Map<string, Draft>): ProjectInstruction[] {
  const instructions: ProjectInstruction[] = []
  let includedChars = 0
  const ordered = [...drafts.values()].sort(compareDrafts)
  for (const draft of ordered) {
    const instruction: ProjectInstruction = {
      relativePath: draft.relativePath,
      tools: TOOL_ORDER.filter((tool) => draft.tools.has(tool)),
      kind: draft.kind,
      activation: draft.activation,
      title: draft.title,
      description: draft.description,
      patterns: draft.patterns,
    }
    if (draft.kind === 'rule' && draft.activation === 'always') {
      const body = draft.bodyText?.trim() ?? ''
      if (!body) {
        instruction.omittedReason = '正文是空的'
      } else if (body.length > MAX_INCLUDED_BODY_CHARS) {
        instruction.omittedReason = `单文件超过 ${MAX_INCLUDED_BODY_CHARS} 字,需要时用 read_file 读取`
      } else if (includedChars + body.length > MAX_INCLUDED_TOTAL_CHARS) {
        instruction.omittedReason = `始终生效的规则合计超过 ${MAX_INCLUDED_TOTAL_CHARS} 字,需要时用 read_file 读取`
      } else {
        instruction.includedBody = body
        includedChars += body.length
      }
    }
    instructions.push(instruction)
  }
  return instructions.sort(compareInstructions)
}

function renderInstructionSection(instructions: readonly ProjectInstruction[]): string {
  if (instructions.length === 0) return ''
  const lines = [
    '## 项目里其他工具留下的规则和提示词',
    '这些文件已经在仓库里,来自 opencode、cursor、claude、kiro。',
    '始终生效的规则按原文遵守。规则冲突时,离正在改的文件更近的约定优先。',
    '提示词不是始终生效的规则。用户点名,或任务和描述明显对上时,先 read_file 再按正文做。',
  ]
  const included = instructions.filter((item) => item.includedBody)
  if (included.length > 0) {
    lines.push('', '### 始终生效的规则')
    for (const item of included) {
      lines.push('', `#### ${item.relativePath}`, `来源:${item.tools.join('、')}`, item.includedBody ?? '')
    }
  }
  const indexedRules = instructions.filter((item) => item.kind === 'rule' && !item.includedBody)
  if (indexedRules.length > 0) {
    lines.push('', '### 还没放进上下文的规则', '读到或改到匹配的文件时,先用 read_file 读规则再动手。')
    for (const item of indexedRules) lines.push(formatIndexLine(item))
  }
  const prompts = instructions.filter((item) => item.kind === 'prompt')
  if (prompts.length > 0) {
    lines.push('', '### 提示词')
    for (const item of prompts) lines.push(formatIndexLine(item))
  }
  return lines.join('\n')
}

function formatIndexLine(item: ProjectInstruction): string {
  const activation = item.activation === 'always'
    ? '始终'
    : item.activation === 'file-match'
      ? (item.patterns.length > 0 ? `匹配 ${item.patterns.join(', ')}` : '按文件')
      : item.activation === 'intelligent'
        ? '按描述判断'
        : '点名才用'
  const extra = [
    item.title !== item.relativePath && item.title !== posixBasename(item.relativePath) ? item.title : '',
    item.description ?? '',
    item.omittedReason ?? '',
  ].filter(Boolean).join('；')
  const kind = item.kind === 'rule' ? '规则' : '提示词'
  return `- ${item.relativePath}（${item.tools.join('、')} ${kind}，${activation}${extra ? `；${extra}` : ''}）`
}

function compareInstructions(left: ProjectInstruction, right: ProjectInstruction): number {
  if (left.kind !== right.kind) return left.kind === 'rule' ? -1 : 1
  return comparePath(left.relativePath, right.relativePath)
}

function compareDrafts(left: Draft, right: Draft): number {
  if (left.kind !== right.kind) return left.kind === 'rule' ? -1 : 1
  return comparePath(left.relativePath, right.relativePath)
}

function comparePath(left: string, right: string): number {
  const rank = inclusionRank(left) - inclusionRank(right)
  if (rank !== 0) return rank
  return left.localeCompare(right)
}

function inclusionRank(relativePath: string): number {
  const name = posixBasename(relativePath.split('#')[0] ?? relativePath)
  if (name === 'AGENTS.md') return 0
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') return 1
  if (relativePath === '.cursorrules' || relativePath.startsWith('.cursor/')) return 2
  if (relativePath.startsWith('.kiro/')) return 3
  if (relativePath.startsWith('.opencode/') || relativePath.startsWith('opencode.json')) return 4
  return 5
}

async function expandInstructionPattern(
  pattern: string,
  pathGuard: PathGuard,
  logger: InstructionLog,
): Promise<string[]> {
  const trimmed = pattern.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    logger.warn({ pattern: trimmed }, '远程规则不抓取,已跳过')
    return []
  }
  if (trimmed.split(/[\\/]/).includes('..')) {
    logger.warn({ pattern: trimmed }, '规则路径在工作区外,已跳过')
    return []
  }

  let local = trimmed
  if (local === '~' || local.startsWith('~/') || local.startsWith('~\\')) {
    const expanded = local === '~' ? os.homedir() : path.resolve(os.homedir(), local.slice(2))
    if (!(await pathGuard.isInside(expanded))) {
      logger.warn({ pattern: trimmed }, '规则路径在工作区外,已跳过')
      return []
    }
    local = path.relative(pathGuard.workspace, expanded)
  }
  if (path.isAbsolute(local)) {
    if (!(await pathGuard.isInside(local))) {
      logger.warn({ pattern: trimmed }, '规则路径在工作区外,已跳过')
      return []
    }
    return [local]
  }
  if (!/[ *?[\]]/.test(local)) {
    const absolute = path.resolve(pathGuard.workspace, local)
    if (!(await pathExists(absolute))) {
      logger.warn({ pattern: trimmed }, '指令文件不存在,已跳过')
      return []
    }
    return [absolute]
  }

  const matches: string[] = []
  try {
    for await (const match of glob(local, { cwd: pathGuard.workspace })) {
      const parts = match.split(/[\\/]/)
      if (parts.some((part) => SKIP_DIRECTORY_NAMES.has(part))) continue
      matches.push(path.join(pathGuard.workspace, match))
    }
  } catch (error) {
    logger.warn({ pattern: trimmed, errorMessage: errorMessage(error) }, '指令通配符无法展开,已跳过')
    return []
  }
  matches.sort()
  const inside: string[] = []
  for (const match of matches) {
    if (await pathGuard.isInside(match)) inside.push(match)
    else logger.warn({ path: match }, '路径越出工作区,已跳过')
  }
  if (inside.length > MAX_INSTRUCTION_MATCHES) {
    logger.warn({ pattern: trimmed, count: inside.length }, '指令文件过多,已截断')
    return inside.slice(0, MAX_INSTRUCTION_MATCHES)
  }
  return inside
}

async function readProjectText(
  filePath: string,
  pathGuard: PathGuard,
  logger: InstructionLog,
  options: { missingOk?: boolean } = {},
): Promise<string | undefined> {
  let realPath: string
  try {
    realPath = await pathGuard.resolve(filePath)
  } catch (error) {
    if (options.missingOk && isMissing(error)) return undefined
    logger.warn({ path: filePath, errorMessage: errorMessage(error) }, '路径越出工作区,已跳过')
    return undefined
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(realPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (options.missingOk && (code === 'ENOENT' || code === 'ENOTDIR')) return undefined
    logger.warn({ path: filePath, errorMessage: errorMessage(error) }, '规则文件读取失败,已跳过')
    return undefined
  }
  if (!stat.isFile()) return undefined
  if (stat.size > MAX_FILE_BYTES) {
    logger.warn({ path: filePath, size: stat.size }, '规则文件过大,已跳过')
    return undefined
  }
  try {
    const text = await fs.readFile(realPath, 'utf8')
    if (text.includes('\u0000')) {
      logger.warn({ path: filePath }, '规则文件不是文本,已跳过')
      return undefined
    }
    return text
  } catch (error) {
    logger.warn({ path: filePath, errorMessage: errorMessage(error) }, '规则文件读取失败,已跳过')
    return undefined
  }
}

async function relativeProjectPath(pathGuard: PathGuard, filePath: string): Promise<string> {
  const realPath = await pathGuard.resolve(filePath)
  return toPosixRelative(pathGuard.workspace, realPath)
}

function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function splitFrontmatter(text: string): { data: Record<string, FrontmatterValue>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized }
  const closing = normalized.indexOf('\n---', 3)
  if (closing === -1) return { data: {}, body: normalized }
  const raw = normalized.slice(4, closing)
  let body = normalized.slice(closing + 4)
  if (body.startsWith('\n')) body = body.slice(1)
  return { data: parseSimpleYaml(raw), body }
}

function parseSimpleYaml(raw: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {}
  let listKey: string | undefined
  for (const line of raw.split('\n')) {
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
    data[key] = parseScalar(key, value)
  }
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

function stringValue(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringList(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function stringListFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(body)
  return match?.[1]?.trim()
}

function promptFileHint(prompt: string): string | undefined {
  const trimmed = prompt.trim()
  if (!trimmed || trimmed.includes('\n')) return undefined
  if (trimmed.startsWith('file://')) return trimmed.slice('file://'.length)
  if (trimmed.endsWith('.md') || trimmed.endsWith('.txt')) return trimmed
  return undefined
}

function clip(text: string | undefined, max = MAX_DESCRIPTION_CHARS): string | undefined {
  if (!text) return undefined
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

function posixBasename(filePath: string): string {
  const normalized = filePath.split('#')[0] ?? filePath
  const parts = normalized.split('/')
  return parts[parts.length - 1] ?? normalized
}

function posixDirname(filePath: string): string {
  const parts = filePath.split('/')
  parts.pop()
  return parts.join('/') || '.'
}

function stripJsonComments(input: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (inString) {
      output += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === '/' && input[index + 1] === '/') {
      index += 2
      while (index < input.length && input[index] !== '\n') index++
      output += '\n'
      continue
    }
    if (char === '/' && input[index + 1] === '*') {
      index += 2
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index++
      index++
      continue
    }
    // 尾逗号只在字符串外面丢掉,避免把正文里的 ",}" 改掉
    if (char === ',') {
      let look = index + 1
      while (look < input.length && /\s/.test(input[look] ?? '')) look++
      const next = input[look]
      if (next === '}' || next === ']') continue
    }
    output += char
  }
  return output
}

function noteTruncation(state: ScanState, logger: InstructionLog, message: string): void {
  if (state.truncated) return
  state.truncated = true
  logger.warn({ maxInstructions: MAX_INSTRUCTIONS, maxDirectories: MAX_DIRECTORIES }, message)
}

async function readDirectory(directory: string, logger: InstructionLog): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    logger.warn({ path: directory, errorMessage: errorMessage(error) }, '读取目录失败,已跳过')
    return []
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
