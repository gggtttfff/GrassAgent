// src/tools.ts
// 内置工具:读写代码、执行验证,以及必要时的用户澄清。
// 每个工具是纯函数:async => string,不耦合 agent 状态。
// 所有文件路径都要过 pathGuard 沙箱,命令执行的工作目录也锁定在沙箱内。
// 参数 schema 用 pi-schema 的 builders 写,类型和校验规则只有一处定义。

import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import { obj, str, arr } from '@earendil-works/pi-schema'
import type { AgentTool } from './agent.ts'
import { createPathGuard, describePathError, type PathGuard } from './pathGuard.ts'

const execAsync = promisify(exec)

// 工具输出截取上限(行数),超过则截取尾部并提示
const MAX_OUTPUT_LINES = 200

// 命令执行超时(毫秒)。默认 3 秒——编译、跑测试这类任务通常要更久,
// 可通过 GRASSAGENT_COMMAND_TIMEOUT_MS 调整。
const DEFAULT_COMMAND_TIMEOUT_MS = 3000

let truncateCounter = 0

// 截取工具输出:超过 maxLines 行时只保留尾部,完整输出写到临时文件。
// 尾部优先——错误信息通常在尾部。
async function truncateOutput(content: string, maxLines = MAX_OUTPUT_LINES): Promise<string> {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(-maxLines).join('\n')
  const tmpPath = path.join(os.tmpdir(), `grassagent_output-${process.pid}-${truncateCounter++}.txt`)
  await fs.writeFile(tmpPath, content, 'utf-8')
  return `[output truncated:showing last ${maxLines} of ${lines.length} lines. full output :${tmpPath}\n${kept}]`
}

// 统计子串出现次数,用于 edit 工具的唯一性校验。
// 必须按出现位置遍历而不是 split 计数:
// split 会把重叠匹配也算进去("aa"里的"a"被算两次),导致误报"多处匹配"。
function countOccurrences(content: string, target: string): number {
  if (!target) return 0
  let count = 0
  let searchFrom = 0
  while (true) {
    const found = content.indexOf(target, searchFrom)
    if (found < 0) break
    count++
    // 从匹配点之后继续,重叠匹配不重复计数
    searchFrom = found + target.length
  }
  return count
}

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

const askUserParameters = obj({
  question: str({ description: '要问用户的问题,具体且简短' }),
})

/** 向用户提问并等待回答。由界面层注入,工具本身不持有终端状态。 */
export type AskUserHandler = (question: string, signal?: AbortSignal) => Promise<string>

// ask_user:信息不足时向用户澄清,回答作为工具结果回填。
function buildAskUser(askUser: AskUserHandler): AgentTool {
  return {
    name: 'ask_user',
    description:
      '向用户提问并等待回答.参数:question(问题).仅在缺少关键信息、继续执行可能做错时使用,' +
      '能自己查到的信息不要问用户',
    parameters: askUserParameters,
    // 提问期间不能和其他工具并发:回答决定后续动作,而且界面同时只能接一个问题
    sequential: true,
    execute: async (args, signal) => {
      const { question } = args as { question: string }
      if (!question.trim()) return 'error:question must not be empty'
      if (signal?.aborted) return 'error:aborted'
      return await askUser(question.trim(), signal)
    },
  }
}

// read_file:返回文件内容(截取文件尾部 200 行)
function buildReadFile(pathGuard: PathGuard): AgentTool {
  return {
    name: 'read_file',
    description: '读取文件内容.参数:path(文件路径).大文件截取最后200行',
    parameters: readFileParameters,
    execute: async (args) => {
      const { path: filePath } = args as { path: string }
      try {
        const resolvedPath = await pathGuard.resolve(filePath)
        const content = await fs.readFile(resolvedPath, 'utf-8')
        return await truncateOutput(content)
      } catch (error) {
        return describePathError(error)
      }
    },
  }
}

// write_file 覆盖写入文件
function buildWriteFile(pathGuard: PathGuard): AgentTool {
  return {
    name: 'write_file',
    description: '写入文件(覆盖).父目录不存在时自动创建.参数:path(路径),content(内容)',
    parameters: writeFileParameters,
    // 声明会修改 path 指向的文件:并发执行时同一文件的写操作会排队,不会互相覆盖
    mutatesFiles: ['path'],
    execute: async (args) => {
      const { path: filePath, content } = args as { path: string; content: string }
      try {
        const resolvedPath = await pathGuard.resolve(filePath)
        await fs.mkdir(path.dirname(resolvedPath) || '.', { recursive: true })
        await fs.writeFile(resolvedPath, content, 'utf-8')
        return `wrote ${resolvedPath} (${content.length} chars)`
      } catch (error) {
        return describePathError(error)
      }
    },
  }
}

// edit 局部字符串替换(精确匹配 + 唯一性校验)
function buildEdit(pathGuard: PathGuard): AgentTool {
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
        const resolvedPath = await pathGuard.resolve(filePath)
        const content = await fs.readFile(resolvedPath, 'utf-8')
        const failure = checkUniqueMatch(content, old_string)
        if (failure?.reason === 'not_found') {
          throw new Error(`old_string not found in ${resolvedPath}`)
        }
        if (failure?.reason === 'not_unique') {
          throw new Error(`old_string matches ${failure.count} places in ${resolvedPath},must be unique`)
        }
        // 用函数替换,避免 new_string 里的 $ 特殊字符($& $` $' $1) 被 String.replace 解释
        const newContent = content.replace(old_string, () => new_string)
        await fs.writeFile(resolvedPath, newContent, 'utf-8')
        return `edited ${resolvedPath}:replace ${old_string.length} chars`
      } catch (error) {
        return describePathError(error)
      }
    },
  }
}

// old_string 必须唯一匹配。
// 返回 null 表示匹配唯一、可以替换;否则返回失败原因。
// 规则只有这一份实现——单次编辑和批量编辑只是措辞不同,避免两边漂移。
type MatchFailure = { reason: 'not_found' } | { reason: 'not_unique'; count: number }

function checkUniqueMatch(content: string, old_string: string): MatchFailure | null {
  const count = countOccurrences(content, old_string)
  if (count === 0) return { reason: 'not_found' }
  if (count > 1) return { reason: 'not_unique', count }
  return null
}

// 批量替换的核心逻辑。
//
// 语义:
// 1. 顺序应用——每一项都在前一项的结果上替换。模型说"先把 A 改成 B,再把 B 改成 C"
//    时,结果应该和按顺序调两次 edit 一致
// 2. 原子性——全部替换成功才写文件。中间任何一项失败,文件保持原样。
//    半改完的文件比没改更糟:模型看不到哪些成功了,下一轮重试会重复应用
// 3. 唯一性——每一项的 old_string 都必须在当前内容里唯一匹配。
//    这条比单次 edit 更严:同一批里两次替换可能命中同一段文本
function applyEdits(
  content: string,
  edits: { old_string: string; new_string: string }[],
  filePath: string,
): string {
  let result = content
  for (let index = 0; index < edits.length; index++) {
    const { old_string, new_string } = edits[index]
    // 错误信息标出是第几处出的问题,模型才知道该改哪一项
    const failure = checkUniqueMatch(result, old_string)
    if (failure?.reason === 'not_found') {
      throw new Error(`第 ${index + 1} 处替换的 old_string 在 ${filePath} 中找不到`)
    }
    if (failure?.reason === 'not_unique') {
      throw new Error(`第 ${index + 1} 处替换的 old_string 匹配了 ${failure.count} 处,必须唯一`)
    }
    // 用函数替换,避免 new_string 里的 $ 特殊字符($& $` $' $1) 被 String.replace 解释
    result = result.replace(old_string, () => new_string)
  }
  return result
}

// edit_batch:一次改多处。所有替换成功才写文件,任一失败则文件保持原样。
function buildEditBatch(pathGuard: PathGuard): AgentTool {
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
        const resolvedPath = await pathGuard.resolve(filePath)
        const content = await fs.readFile(resolvedPath, 'utf-8')
        // applyEdits 抛错时文件还没被碰过,天然满足原子性
        const newContent = applyEdits(content, edits, resolvedPath)
        await fs.writeFile(resolvedPath, newContent, 'utf-8')
        const replacedChars = edits.reduce((total, edit) => total + edit.old_string.length, 0)
        return `edited ${resolvedPath}:${edits.length} replacements, ${replacedChars} chars`
      } catch (error) {
        return describePathError(error)
      }
    },
  }
}

// run_bash:执行 shell 命令(截取尾部输出防止超出最大输出)
// 工作目录锁定在工作区,避免命令写到别处
function buildRunBash(pathGuard: PathGuard, timeoutMs: number): AgentTool {
  return {
    name: 'run_bash',
    description: '执行shell命令.参数:command(命令字符串).在工作目录内执行,返回stdout+stderr,截取最后200行',
    parameters: runBashParameters,
    execute: async (args, signal) => {
      const { command } = args as { command: string }
      try {
        // cwd 固定为工作区:模型给的相对路径命令只在工作区内生效
        const { stdout, stderr } = await execAsync(command, {
          cwd: pathGuard.workspace,
          maxBuffer: 1024 * 1024,
          timeout: timeoutMs,
          signal,
        })
        const output = stderr ? `[stderr] ${stderr}\n[stdout] ${stdout}` : stdout
        return await truncateOutput(output)
      } catch (error) {
        if (signal?.aborted) return 'aborted'
        const failure = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
        return `[exit ${failure.code}] ${failure.stderr ?? ''}${failure.stdout ?? ''}`
      }
    },
  }
}

// 返回全部内置工具。
// workspace 缺省用当前工作目录,不传则沙箱范围就是进程启动目录。
// askUser 由调用方注入;没有交互界面时不注册提问工具,避免模型调用后等不到回答。
export async function builtinTools(options: {
  workspace?: string
  commandTimeoutMs?: number
  askUser?: AskUserHandler
} = {}): Promise<AgentTool[]> {
  const pathGuard = await createPathGuard(options.workspace ?? process.cwd())
  const tools = [
    buildReadFile(pathGuard),
    buildWriteFile(pathGuard),
    buildEdit(pathGuard),
    buildEditBatch(pathGuard),
    buildRunBash(pathGuard, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
  ]
  if (options.askUser) tools.push(buildAskUser(options.askUser))
  return tools
}
