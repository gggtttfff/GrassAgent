// src/agent/tools.ts
// 四个工具:能读写代码并执行验证的最小集。
// 每个工具是纯函数:async => string,不耦合 agent 状态。
// 文件和命令都交给 ExecutionWorld,工具自己不再碰 fs 或子进程。
// 参数 schema 用 pi-schema 的 builders 写,类型和校验规则只有一处定义。

import { obj, str, arr, oneOf, opt, int, bool } from '@earendil-works/pi-schema'
import { assertSkillAllowed, type ApprovalGate } from '../world/approvalGate.ts'
import type { AgentTool } from './agent.ts'
import { createWorldPort, type WorldPort } from '../plugin/ports.ts'
import type { ExecutionWorld } from '../world/executionWorld.ts'
import { formatExecResult, createLocalWorld } from '../world/localWorld.ts'
import { describePathError } from '../core/pathGuard.ts'
import { formatSkillForModel, type Skill, type SkillRegistry } from '../instructions/skills.ts'
import { TextEditError } from '../core/textEdit.ts'
import {
  MAX_BLOCKING_WAIT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  type MonitorKind,
  type MonitorRegistry,
} from './monitor.ts'
import {
  findDangerousCommand,
  formatDangerousCommandRejection,
  type DangerousCommandRule,
} from './dangerousCommands.ts'

// 命令执行超时(毫秒)。默认 3 秒——编译、跑测试这类任务通常要更久,
// 可通过 GRASSAGENT_COMMAND_TIMEOUT_MS 调整。
const DEFAULT_COMMAND_TIMEOUT_MS = 3000

// 一批技能正文的总长度上限。一次取太多会把上下文塞满,不如让模型分批来。
const MAX_BATCH_SKILL_CHARS = 48_000

// 参数 schema。用封闭对象(additionalProperties: false):
// 模型多传的字段是幻觉,直接拒绝比静默忽略更容易让它自我纠正。
const readFileParameters = obj({
  path: str({ description: '要读取的文件路径,相对路径基于工作目录' }),
})

const writeFileParameters = obj({
  path: str({ description: '要写入的文件路径,相对路径基于工作目录' }),
  content: str({ description: '文件内容' }),
})

const editParameters = obj({
  path: str({ description: '文件路径,相对路径基于工作目录' }),
  old_string: str({ description: '要替换的文本,必须在文件中唯一匹配' }),
  new_string: str({ description: '替换后的文本' }),
})

// 批量替换的参数。每一项和单次 edit 一样,只是排成数组。
const editBatchParameters = obj({
  path: str({ description: '文件路径,相对路径基于工作目录' }),
  edits: arr(
    obj({
      old_string: str({ description: '要替换的文本,必须在文件中唯一匹配' }),
      new_string: str({ description: '替换后的文本' }),
    }),
    { description: '替换列表,按顺序依次应用', minItems: 1 },
  ),
})

const runBashParameters = obj({
  command: str({ description: '要执行的 shell 命令' }),
})

const loadSkillParameters = obj({
  names: arr(str({ description: '技能名,和可用技能列表里的一致' }), {
    description: '要加载的技能名列表',
    minItems: 1,
    maxItems: 8,
  }),
})

const monitorParameters = obj({
  kind: oneOf(['command', 'timer', 'sandbox'], {
    description: 'command 跑命令;timer 纯定时;sandbox 沙盒和连接状态',
  }),
  command: opt(str({ description: 'kind=command 时要执行的 shell 命令' })),
  afterMs: opt(int({
    minimum: 0,
    maximum: MAX_COMMAND_TIMEOUT_MS,
    description: '多少毫秒后先报一次状态。不给就只有结束报告',
  })),
  timeoutMs: opt(int({
    minimum: 1000,
    maximum: MAX_COMMAND_TIMEOUT_MS,
    description: '命令最多跑多久,到点直接杀掉',
  })),
  wait: opt(bool({
    description: 'true 表示在本次调用内等到报告;默认后台,回合结束也会把结果推回来',
  })),
})

// read_file:返回文件内容。超过 200 行或字节上限时只带尾部,全文在世界的临时区。
function buildReadFile(world: WorldPort): AgentTool {
  return {
    name: 'read_file',
    description: '读取文件内容.参数:path(文件路径).大文件截取最后200行',
    parameters: readFileParameters,
    execute: async (args) => {
      const { path: filePath } = args as { path: string }
      try {
        return await world.read(filePath)
      } catch (error) {
        return describePathError(error)
      }
    },
  }
}

// write_file 覆盖写入文件
function buildWriteFile(world: WorldPort): AgentTool {
  return {
    name: 'write_file',
    description: '写入文件(覆盖).父目录不存在时自动创建.参数:path(路径),content(内容)',
    parameters: writeFileParameters,
    // 声明会修改 path 指向的文件:并发执行时同一文件的写操作会排队,不会互相覆盖
    mutatesFiles: ['path'],
    requiresApproval: true,
    execute: async (args) => {
      const { path: filePath, content } = args as { path: string; content: string }
      try {
        const resolvedPath = await world.write(filePath, content)
        return `wrote ${resolvedPath} (${content.length} chars)`
      } catch (error) {
        return describePathError(error)
      }
    },
  }
}

// edit 局部字符串替换(精确匹配 + 唯一性校验)
function buildEdit(world: WorldPort): AgentTool {
  return {
    name: 'edit',
    description: '编辑文件:精确替换一段文本.参数:path,old_string,new_string.old_string必须在文件中唯一,否则报错',
    parameters: editParameters,
    // edit 是"读-改-写",并发执行同一文件会丢更新,必须排队
    mutatesFiles: ['path'],
    requiresApproval: true,
    execute: async (args) => {
      const { path: filePath, old_string, new_string } = args as {
        path: string
        old_string: string
        new_string: string
      }
      try {
        const resolvedPath = await world.edit(filePath, [{ old_string, new_string }])
        return `edited ${resolvedPath}:replace ${old_string.length} chars`
      } catch (error) {
        return formatSingleEditError(error)
      }
    },
  }
}

// edit_batch:一次改多处。所有替换成功才写文件,任一失败则文件保持原样。
function buildEditBatch(world: WorldPort): AgentTool {
  return {
    name: 'edit_batch',
    description:
      '批量编辑文件:一次替换多处.参数:path(文件路径),edits(替换列表,每项含old_string和new_string).' +
      '按顺序依次应用,old_string每次都必须在当前内容里唯一匹配.全部成功才写入,任一失败则文件不变',
    parameters: editBatchParameters,
    // 读-改-写,并发执行同一文件会丢更新,必须排队
    mutatesFiles: ['path'],
    requiresApproval: true,
    execute: async (args) => {
      const { path: filePath, edits } = args as {
        path: string
        edits: { old_string: string; new_string: string }[]
      }
      try {
        const resolvedPath = await world.edit(filePath, edits)
        const replacedChars = edits.reduce((total, edit) => total + edit.old_string.length, 0)
        return `edited ${resolvedPath}:${edits.length} replacements, ${replacedChars} chars`
      } catch (error) {
        return formatBatchEditError(error)
      }
    },
  }
}

// run_bash:执行 shell 命令。argv 交给世界,不在工具里再包一层 shell。
// 危险命令规则在这里拦一道:模式再宽,这几条命令也不跑。
function buildRunBash(
  world: WorldPort,
  timeoutMs: number,
  dangerousCommands: readonly DangerousCommandRule[],
  rulesPath: string,
): AgentTool {
  return {
    name: 'run_bash',
    description: '执行shell命令.参数:command(命令字符串).在工作目录内执行,返回stdout+stderr,截取最后200行',
    parameters: runBashParameters,
    requiresApproval: true,
    execute: async (args, signal) => {
      const { command } = args as { command: string }
      const blocked = findDangerousCommand(dangerousCommands, command)
      if (blocked) return formatDangerousCommandRejection(blocked, rulesPath)
      try {
        const result = await world.exec({
          argv: ['bash', '-c', command],
          cwd: world.workspaceRoot,
          timeoutMs,
        }, signal)
        return formatExecResult(result)
      } catch (error) {
        if (signal?.aborted) return 'aborted'
        return describePathError(error)
      }
    },
  }
}

// monitor:起一个监视器,过一会儿把状态报回来。
//
// 两种用法:
//   - 默认后台:起完立刻返回,回合照常结束。到点或命令结束时由注册表回调出去,
//     调用方负责把状态推回上下文并开新一轮。
//   - wait=true:在本次调用内等到命令结束或到点,直接把状态当工具结果返回。
//
// 它会跑命令,所以和 run_bash 一样要过审批、过危险命令规则。
function buildMonitor(
  monitors: MonitorRegistry,
  dangerousCommands: readonly DangerousCommandRule[],
  rulesPath: string,
): AgentTool {
  return {
    name: 'monitor',
    description:
      '监视一段时间内的状态,可选在若干毫秒后和结束时向模型报告.参数:' +
      'kind(command 跑命令 / timer 纯定时 / sandbox 沙盒连接状态),' +
      'command(命令,kind=command 必填),afterMs(多少毫秒后先报一次),' +
      'timeoutMs(命令最长运行时间,到点杀掉),wait(true 则在本次调用内等到报告,默认后台)',
    parameters: monitorParameters,
    requiresApproval: true,
    execute: async (args, signal) => {
      const input = args as {
        kind: MonitorKind
        command?: string
        afterMs?: number
        timeoutMs?: number
        wait?: boolean
      }

      if (input.kind === 'command') {
        const command = input.command?.trim()
        if (!command) return 'error: kind=command 时必须给 command'
        // 后台跑的命令同样受危险命令规则约束,不能因为「看不见」就放行
        const blocked = findDangerousCommand(dangerousCommands, command)
        if (blocked) return formatDangerousCommandRejection(blocked, rulesPath)
      }

      let started
      try {
        started = await monitors.start({
          kind: input.kind,
          command: input.command,
          afterMs: input.afterMs,
          timeoutMs: input.timeoutMs,
        })
      } catch (error) {
        return `error: ${(error as Error).message}`
      }

      if (!input.wait) return started.text
      if (signal?.aborted) return 'error:aborted'

      // 阻塞模式也要有上限:等太久不如让模型先干别的,监视器继续在后台跑。
      const report = await raceWithTimeout(started.firstReport, MAX_BLOCKING_WAIT_MS)
      if (report === undefined) {
        return `等了 ${Math.round(MAX_BLOCKING_WAIT_MS / 1000)} 秒还没结束,监视器 ${started.id} 继续在后台跑,`
          + '结束时会推给你。'
      }
      return report
    },
  }
}

/** 等到 promise 或超时。超时返回 undefined,并且不会留下定时器拖住进程。 */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
    // 阻塞等待不该成为进程退不出去的理由
    timer.unref()
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// load_skill:按名字取技能正文。
// 正文是启动时扫进内存的,不在工具里重新读盘——技能目录改到一半读进来更糟。
// 附件不在这里返回,模型按正文指到的路径自己用 read_file 读。
//
// 支持一次取多个:任务常常要连着看两三个技能,一个一个来要多跑几轮。
//
// 审批在加载之前:技能正文是仓库里的文本,拿到它就等于让模型按别人的指令做事。
// 没拿到放行就不给正文,只回一句让模型别再试。
function buildLoadSkill(skills: SkillRegistry, approval: ApprovalGate | undefined): AgentTool {
  return {
    name: 'load_skill',
    description:
      '加载技能的完整说明.参数:names(技能名列表,和可用技能列表一致,最多 8 个).' +
      '返回技能正文和附件目录;正文提到的脚本、模板用 read_file 按需读',
    parameters: loadSkillParameters,
    // 审批要占用输入通道,不能和别的工具并发跑
    sequential: true,
    execute: async (args, signal) => {
      if (signal?.aborted) return 'error:aborted'
      const { names } = args as { names: string[] }
      const requested = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
      if (requested.length === 0) return 'error: load_skill 的 names 不能为空'

      const found: Skill[] = []
      const missing: string[] = []
      for (const name of requested) {
        const skill = skills.find(name)
        // 报错里带上可用名字,模型下一次就能改对,不用再试一遍
        if (!skill) missing.push(name)
        else found.push(skill)
      }
      if (found.length === 0) {
        return `error: 没有名为 ${missing.map((name) => `"${name}"`).join('、')} 的技能。可用技能:${skills.names().join('、')}`
      }

      // 一批技能问一次。逐个问的话,一次八个技能要弹八次。
      const summary = found.map((skill) => skill.name).join('、')
      try {
        await assertSkillAllowed(approval, summary)
      } catch (error) {
        return `error: ${(error as Error).message}。不要再次请求加载技能,按现有信息继续。`
      }

      const sections: string[] = []
      let totalChars = 0
      for (const skill of found) {
        const section = formatSkillForModel(skill)
        // 一批技能的总长度要有上限,不然一次塞满上下文
        if (totalChars + section.length > MAX_BATCH_SKILL_CHARS) {
          sections.push(`(其余技能因总量超过 ${MAX_BATCH_SKILL_CHARS} 字未加载)`)
          break
        }
        totalChars += section.length
        sections.push(section)
      }
      if (missing.length > 0) {
        sections.push(`error: 没有名为 ${missing.map((name) => `"${name}"`).join('、')} 的技能。可用技能:${skills.names().join('、')}`)
      }
      return sections.join('\n\n---\n\n')
    },
  }
}

/**
 * 换掉工具集里的 load_skill。
 *
 * 会话内重新扫描技能后,工具里那个闭包还指着旧的注册表。
 * 换掉它,模型下一次调用拿到的才是新的技能。
 * 技能从有到无时要把工具摘掉——留着它模型只会拿到「没有名为 xxx 的技能」。
 */
export function replaceLoadSkillTool(
  tools: AgentTool[],
  skills: SkillRegistry,
  approval: ApprovalGate | undefined,
): void {
  const index = tools.findIndex((tool) => tool.name === 'load_skill')
  if (skills.names().length === 0) {
    if (index >= 0) tools.splice(index, 1)
    return
  }
  const replacement = buildLoadSkill(skills, approval)
  if (index >= 0) tools[index] = replacement
  else tools.push(replacement)
}

// 单次编辑的措辞要和改动前一致,模型已经靠这些句子判断该重发哪一段。
function formatSingleEditError(error: unknown): string {
  if (error instanceof TextEditError && error.reason === 'not_found') {
    return `error: old_string not found in ${error.filePath}`
  }
  if (error instanceof TextEditError && error.reason === 'not_unique') {
    return `error: old_string matches ${error.count} places in ${error.filePath},must be unique`
  }
  return describePathError(error)
}

// 批量编辑标出是第几处失败。文件没有被写,所以模型可以整批重发。
function formatBatchEditError(error: unknown): string {
  if (error instanceof TextEditError && error.reason === 'not_found') {
    return `error: 第 ${error.index + 1} 处替换的 old_string 在 ${error.filePath} 中找不到`
  }
  if (error instanceof TextEditError && error.reason === 'not_unique') {
    return `error: 第 ${error.index + 1} 处替换的 old_string 匹配了 ${error.count} 处,必须唯一`
  }
  return describePathError(error)
}

/**
 * 返回全部内置工具。
 * 传入 world 时文件和命令都进那一个世界;不传则在本机工作区建一个本地世界。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function builtinTools(options: {
  workspace?: string
  commandTimeoutMs?: number
  world?: ExecutionWorld
  skills?: SkillRegistry
  /** 加载技能前要过的审批门 */
  approval?: ApprovalGate
  /** 危险命令规则。命中就直接拒绝,不执行。 */
  dangerousCommands?: readonly DangerousCommandRule[]
  /** 规则文件路径。只在拒绝时给模型看,让它知道去哪儿改。 */
  dangerousCommandsPath?: string
  /** 监视器注册表。给了才注册 monitor 工具 */
  monitors?: MonitorRegistry
} = {}): Promise<AgentTool[]> {
  const world = createWorldPort(
    options.world ?? await createLocalWorld({ workspace: options.workspace ?? process.cwd() }),
  )
  const dangerousCommands = options.dangerousCommands ?? []
  const dangerousCommandsPath = options.dangerousCommandsPath ?? '危险命令规则文件'
  const tools = [
    buildReadFile(world),
    buildWriteFile(world),
    buildEdit(world),
    buildEditBatch(world),
    buildRunBash(
      world,
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      dangerousCommands,
      dangerousCommandsPath,
    ),
  ]
  // 没有注册表就没有后台报告的去处,注册一个只会失败的工具没意义
  if (options.monitors) {
    tools.push(buildMonitor(options.monitors, dangerousCommands, dangerousCommandsPath))
  }
  // 一个技能都没有时不注册 load_skill:模型看见用不上的工具只会乱调
  if (options.skills && options.skills.names().length > 0) {
    tools.push(buildLoadSkill(options.skills, options.approval))
  }
  return tools
}
