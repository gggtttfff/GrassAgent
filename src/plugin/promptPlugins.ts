// src/plugin/promptPlugins.ts
// 规则和技能发现。失败只记日志,不挡启动。正文不进系统提示词。

import type { AgentConfig } from '../config.ts'
import type { Logger } from '../core/logger.ts'
import {
  discoverProjectInstructions,
  formatInstructionReport,
  summarizeInstructions,
} from '../instructions/projectInstructions.ts'
import {
  createLocalSkillFiles,
  createSkillCache,
  createSkillRegistry,
  createWorldSkillFiles,
  describeDisabledSkills,
  describeSkippedSkills,
  discoverSkills,
  mergeSkillCatalogs,
  summarizeSkills,
  SKILL_CACHE_RELATIVE_PATH,
  type SkillCatalog,
  type SkillLog,
  type SkillOrigin,
  type SkillRegistry,
} from '../instructions/skills.ts'
import type { ExecutionWorld } from '../world/executionWorld.ts'

export type RuleSection = {
  instructionSection: string
  instructionReport: string
  instructionNotice: string
}

export type SkillSection = {
  skillSection: string
  skillReport: string
  skills?: SkillRegistry
  skillCatalog?: SkillCatalog
  skillNotices: string[]
}

/**
 * 识别项目规则。抛错时按「这次不加载」继续。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function loadRuleSection(options: {
  enabled: boolean
  workspace: string
  logger: Logger
  discover?: typeof discoverProjectInstructions
}): Promise<RuleSection> {
  if (!options.enabled) {
    return {
      instructionSection: '',
      instructionReport: '项目规则识别已关闭',
      instructionNotice: '',
    }
  }
  const discover = options.discover ?? discoverProjectInstructions
  try {
    const catalog = await discover(options.workspace, {
      warn: (object, message) => options.logger.warn(object, message),
      info: (object, message) => options.logger.info(object, message),
    })
    return {
      instructionSection: catalog.promptSection,
      instructionReport: formatInstructionReport(catalog.instructions),
      instructionNotice: catalog.instructions.length > 0 ? summarizeInstructions(catalog.instructions) : '',
    }
  } catch (error) {
    const instructionReport = '识别项目规则失败,本次不加载外部规则'
    options.logger.error({ errorMessage: (error as Error).message }, '识别项目规则失败,继续启动')
    return {
      instructionSection: '',
      instructionReport,
      instructionNotice: instructionReport,
    }
  }
}

/** 作者：Pieory 创建日期：2025-07-18 */
export function describeSkillOrigin(config: AgentConfig, world: ExecutionWorld): SkillOrigin {
  if (config.ExecutionWorld !== 'remote') {
    return { kind: 'local', label: '本地工作区' }
  }
  if (config.SandboxSshHost) {
    const user = config.SandboxSshUser ? `${config.SandboxSshUser}@` : ''
    const port = config.SandboxSshPort && config.SandboxSshPort !== 22 ? `:${config.SandboxSshPort}` : ''
    return { kind: 'remote', label: `远程 ${user}${config.SandboxSshHost}${port}` }
  }
  if (world.sandboxId) return { kind: 'remote', label: `远程沙盒 ${world.sandboxId}` }
  return { kind: 'remote', label: '远程工作区' }
}

/**
 * 扫描技能。远程时本地和远程各扫一遍,同名以远程为准。
 * 正文留在 load_skill / readRaw,这里只拿索引段。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function scanProjectSkills(options: {
  config: AgentConfig
  world: ExecutionWorld
  logger: Logger
}): Promise<SkillCatalog> {
  const skillOrigin = describeSkillOrigin(options.config, options.world)
  const skillLogger: SkillLog = {
    warn: (object, message) => options.logger.warn(object, message),
    info: (object, message) => options.logger.info(object, message),
  }
  const skillCache = createSkillCache({
    workspace: options.config.Workspace,
    relativePath: SKILL_CACHE_RELATIVE_PATH,
  })
  if (skillOrigin.kind === 'remote') {
    const local = await discoverSkills({
      files: await createLocalSkillFiles(options.config.Workspace),
      origin: { kind: 'local', label: '本地工作区' },
      cache: skillCache,
      logger: skillLogger,
    })
    const remote = await discoverSkills({
      files: createWorldSkillFiles(options.world),
      origin: skillOrigin,
      logger: skillLogger,
    })
    return mergeSkillCatalogs(remote, local, skillLogger)
  }
  return discoverSkills({
    files: await createLocalSkillFiles(options.config.Workspace),
    origin: skillOrigin,
    cache: skillCache,
    logger: skillLogger,
  })
}

/**
 * 加载技能索引。发现失败时按没有技能继续,不把异常抛给启动流程。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function loadSkillSection(options: {
  config: AgentConfig
  world: ExecutionWorld
  logger: Logger
}): Promise<SkillSection> {
  if (!options.config.LoadSkills) {
    return {
      skillSection: '',
      skillReport: '技能加载已关闭',
      skillNotices: [],
    }
  }
  try {
    const scanned = await scanProjectSkills(options)
    return {
      skillSection: scanned.promptSection,
      skillReport: summarizeSkills(scanned.skills),
      skills: createSkillRegistry(scanned.skills),
      skillCatalog: scanned,
      skillNotices: [
        ...describeDisabledSkills(scanned.skills),
        ...describeSkippedSkills(scanned.skills),
      ],
    }
  } catch (error) {
    options.logger.error({ errorMessage: (error as Error).message }, '识别技能失败,继续启动')
    return {
      skillSection: '',
      skillReport: '识别技能失败,本次不加载技能',
      skillNotices: [],
    }
  }
}
