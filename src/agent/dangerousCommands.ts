// src/agent/dangerousCommands.ts
// 危险命令规则 —— 从 JSON 文件读出一组正则,拦住不该跑的命令。
//
// 规则文件读本机工作区,不读沙盒里那份:沙盒里的文件模型能改,
// 规则得是用户这台机器上的配置。
//
// 这是护栏,不是安全边界。匹配的是模型给的命令字符串,
// `bash script.sh`、`find -delete` 这类写法绕得开。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { JsonSafetyError, parseJson } from '../core/jsonSafety.ts'

export class DangerousCommandsError extends Error {
  readonly issues: string[]

  constructor(message: string, issues: string[] = []) {
    super(message)
    this.name = 'DangerousCommandsError'
    this.issues = issues
  }
}

/** 一条规则。正则匹配命令字符串,命中就拒绝。 */
export type DangerousCommandRule = {
  pattern: string
  reason?: string
  /** 编译好的正则。加载时建好,匹配时直接用。 */
  matcher: RegExp
}

const ruleSchema = z.object({
  pattern: z.string().min(1, { error: 'pattern 不能为空' }),
  reason: z.string().min(1, { error: 'reason 不能为空' }).optional(),
}).strict()

const rulesFileSchema = z.object({
  commands: z.array(ruleSchema),
}).strict()

/** 默认路径:工作区下的 .grass/dangerous-commands.json。没有这个文件就等于没有规则。 */
export function defaultDangerousCommandsPath(workspace: string): string {
  return path.join(workspace, '.grass', 'dangerous-commands.json')
}

/**
 * 读取规则文件。
 *
 * 文件不存在返回空列表——那是正常状态,不是错误。
 * 文件存在但写坏了要报出来:规则不生效的话,用户以为自己有防护。
 */
export async function loadDangerousCommandsFile(filePath: string): Promise<DangerousCommandRule[]> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw new DangerousCommandsError(`读取危险命令规则失败: ${(error as Error).message}`)
  }

  let parsed: unknown
  try {
    // 超深的文件能解析成功,后面的校验和序列化会递归爆栈。先量深度。
    parsed = parseJson(content)
  } catch (error) {
    if (error instanceof JsonSafetyError) {
      throw new DangerousCommandsError(`${filePath} ${error.message}`)
    }
    throw new DangerousCommandsError(`${filePath} 不是合法 JSON: ${(error as Error).message}`)
  }

  const result = rulesFileSchema.safeParse(parsed)
  if (!result.success) {
    throw new DangerousCommandsError('危险命令规则校验失败:', formatIssues(result.error))
  }

  const rules: DangerousCommandRule[] = []
  for (const rule of result.data.commands) {
    try {
      rules.push({ ...rule, matcher: new RegExp(rule.pattern) })
    } catch (error) {
      throw new DangerousCommandsError(
        `危险命令规则的 pattern 不是合法正则: ${rule.pattern} (${(error as Error).message})`,
      )
    }
  }
  return rules
}

/**
 * 找出第一条命中的规则。
 * 没命中返回 undefined——调用方照常执行。
 */
export function findDangerousCommand(
  rules: readonly DangerousCommandRule[],
  command: string,
): DangerousCommandRule | undefined {
  return rules.find((rule) => rule.matcher.test(command))
}

/** 给模型看的拒绝理由。说清楚是规则拦的,以及规则在哪儿。 */
export function formatDangerousCommandRejection(
  rule: DangerousCommandRule,
  rulesPath: string,
): string {
  const reason = rule.reason ? rule.reason : '命中危险命令规则'
  return `error: 命令被规则拒绝:${reason}(pattern: ${rule.pattern})。`
    + `换一种做法,或者让用户在 ${rulesPath} 里去掉这条规则。`
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.join('.') || '(root)'
    return `  ${field}: ${issue.message}`
  })
}
