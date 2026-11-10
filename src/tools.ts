// src/tools.ts
// 四个工具:能读写代码并执行验证的最小集。
// 每个工具是纯函数:async => string,不耦合 agent 状态。
// 文件和命令都交给 ExecutionWorld,工具自己不再碰 fs 或子进程。
// 参数 schema 用 pi-schema 的 builders 写,类型和校验规则只有一处定义。

import { obj, str, arr } from '@earendil-works/pi-schema'
import type { AgentTool } from './agent.ts'
import type { ExecutionWorld } from './executionWorld.ts'
import { formatExecResult, createLocalWorld } from './localWorld.ts'
import { describePathError } from './pathGuard.ts'
import { TextEditError } from './textEdit.ts'

// 命令执行超时(毫秒)。默认 3 秒——编译、跑测试这类任务通常要更久,
// 可通过 GRASSAGENT_COMMAND_TIMEOUT_MS 调整。
const DEFAULT_COMMAND_TIMEOUT_MS = 3000

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

// read_file:返回文件内容。超过 200 行或字节上限时只带尾部,全文在世界的临时区。
function buildReadFile(world: ExecutionWorld): AgentTool {
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
function buildWriteFile(world: ExecutionWorld): AgentTool {
  return {
    name: 'write_file',
    description: '写入文件(覆盖).父目录不存在时自动创建.参数:path(路径),content(内容)',
    parameters: writeFileParameters,
    // 声明会修改 path 指向的文件:并发执行时同一文件的写操作会排队,不会互相覆盖
    mutatesFiles: ['path'],
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
function buildEdit(world: ExecutionWorld): AgentTool {
  return {
    name: 'edit',
    description: '编辑文件:精确替换一段文本.参数:path,old_string,new_string.old_string必须在文件中唯一,否则报错',
    parameters: editParameters,
    // edit 是"读-改-写",并发执行同一文件会丢更新,必须排队
    mutatesFiles: ['path'],
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
function buildEditBatch(world: ExecutionWorld): AgentTool {
  return {
    name: 'edit_batch',
    description:
      '批量编辑文件:一次替换多处.参数:path(文件路径),edits(替换列表,每项含old_string和new_string).' +
      '按顺序依次应用,old_string每次都必须在当前内容里唯一匹配.全部成功才写入,任一失败则文件不变',
    parameters: editBatchParameters,
    // 读-改-写,并发执行同一文件会丢更新,必须排队
    mutatesFiles: ['path'],
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
function buildRunBash(world: ExecutionWorld, timeoutMs: number): AgentTool {
  return {
    name: 'run_bash',
    description: '执行shell命令.参数:command(命令字符串).在工作目录内执行,返回stdout+stderr,截取最后200行',
    parameters: runBashParameters,
    execute: async (args, signal) => {
      const { command } = args as { command: string }
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
} = {}): Promise<AgentTool[]> {
  const world = options.world ?? await createLocalWorld({ workspace: options.workspace ?? process.cwd() })
  return [
    buildReadFile(world),
    buildWriteFile(world),
    buildEdit(world),
    buildEditBatch(world),
    buildRunBash(world, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
  ]
}
