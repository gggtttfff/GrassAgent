// src/tools.ts
// 四个工具:能读写代码并执行验证的最小集。
// 每个工具是纯函数:async => string,不耦合 agent 状态。
// 所有文件路径都要过 pathGuard 沙箱,命令执行的工作目录也锁定在沙箱内。
// 参数 schema 用 pi-schema 的 builders 写,类型和校验规则只有一处定义。

import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import { obj, str } from '@earendil-works/pi-schema'
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

const runBashParameters = obj({
  command: str({ description: '要执行的 shell 命令' }),
})

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
        const count = countOccurrences(content, old_string)
        if (count === 0) throw new Error(`old_string not found in ${resolvedPath}`)
        if (count > 1) throw new Error(`old_string matches ${count} places in ${resolvedPath},must be unique`)
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
export async function builtinTools(options: { workspace?: string; commandTimeoutMs?: number } = {}): Promise<AgentTool[]> {
  const pathGuard = await createPathGuard(options.workspace ?? process.cwd())
  return [
    buildReadFile(pathGuard),
    buildWriteFile(pathGuard),
    buildEdit(pathGuard),
    buildRunBash(pathGuard, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
  ]
}
