// src/core/pathGuard.ts
// 沙箱层 —— 把模型给出的路径限制在工作目录内。
// 模型是不可信输入源:它可能因为幻觉或注入而给出 ../../etc/passwd 这样的路径。
//
// 规则:先 resolve 成绝对路径,再判断是否落在工作目录内。
// 关键点:必须在 resolve 之后判断,否则 ../ 还没展开,判断会漏。
//
// 还要防符号链接:工作区里放一个指向外部的软链,
// 路径字符串看起来在工作区内,实际指向的却是工作区外的文件。
// 所以最终判断要用 realpath 解析后的真实路径。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

// 路径越界时抛这个。工具层捕获后转成给模型看的错误文本。
export class PathOutsideWorkspaceError extends Error {
  readonly requestedPath: string
  readonly resolvedPath: string
  readonly workspace: string

  constructor(message: string, details: {
    requestedPath: string
    resolvedPath: string
    workspace: string
  }) {
    super(message)
    this.name = 'PathOutsideWorkspaceError'
    this.requestedPath = details.requestedPath
    this.resolvedPath = details.resolvedPath
    this.workspace = details.workspace
  }
}

export interface PathGuard {
  /** 工作区的真实路径(已解析符号链接) */
  readonly workspace: string
  /**
   * 把输入路径转成工作目录内的绝对路径,越界则抛错。
   * 返回的是真实路径(符号链接已解析),可直接用于文件操作。
   */
  resolve(requestedPath: string): Promise<string>
  /** 判断路径是否在界内,不抛错 */
  isInside(requestedPath: string): Promise<boolean>
}

// Windows 下路径不区分大小写,比较时统一小写;
// POSIX 下区分大小写,保持原样。
function normalizeForComparison(targetPath: string): string {
  return process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
}

// 判断 target 是否在 root 之内(含 root 自身)。
// 用 path.relative 而不是字符串前缀,避免 C:/workbench 把 C:/work 误判为在界内。
function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  if (relative === '') return true
  // relative 以 ".." 加分隔符开头表示向上跳出了 root。
  // 不能简单用 startsWith('..'),否则名为 "..foo" 的子目录会被误判为越界。
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  // 盘符不同(relative 是绝对路径)说明跨盘,也不在界内
  if (path.isAbsolute(relative)) return false
  return true
}

// 解析符号链接,得到真实路径。
// 路径不存在时(比如要新建文件),逐级向上找到最近的已存在祖先,
// 解析它的真实路径后再把剩余部分拼回去——这样父目录里的符号链接也能被识破。
async function resolveRealPath(targetPath: string): Promise<string> {
  const existingAncestor = await findExistingAncestor(targetPath)
  if (!existingAncestor) return targetPath

  try {
    const realAncestor = await fs.realpath(existingAncestor)
    const remainder = path.relative(existingAncestor, targetPath)
    return remainder ? path.join(realAncestor, remainder) : realAncestor
  } catch {
    // realpath 失败(权限不足、竞态删除等),退回原路径。
    // 后续的边界判断仍然会拦住明显越界的路径。
    return targetPath
  }
}

// 从目标路径逐级向上找第一个实际存在的路径
async function findExistingAncestor(targetPath: string): Promise<string | undefined> {
  let current = targetPath
  while (true) {
    try {
      await fs.access(current)
      return current
    } catch {
      const parent = path.dirname(current)
      // 到达根目录还没找到存在的,说明路径整体不存在
      if (parent === current) return undefined
      current = parent
    }
  }
}

// 创建沙箱。
// workspace 会被解析成绝对路径并解析符号链接,保证比较基准稳定。
// macOS 上 /tmp 是 /private/tmp 的软链,不解析会导致误判越界。
export async function createPathGuard(workspace: string): Promise<PathGuard> {
  const resolvedWorkspace = path.resolve(workspace)

  // 工作区的真实路径。
  // 用 resolveRealPath 而不是 fs.realpath:工作区可能还不存在,
  // 这时要逐级向上找到最近的已存在祖先再解析。
  // 不这么做的话,Windows 上工作区是短路径(C:\Users\RUNNER~1\...)
  // 而请求路径解析出长路径(C:\Users\runneradmin\...),
  // 两边形式不一致会把合法路径误判成越界。
  let realWorkspace = resolvedWorkspace
  try {
    realWorkspace = await resolveRealPath(resolvedWorkspace)
  } catch {
    // 工作区还不存在,后续访问会失败,这里不影响边界判断
  }

  // 两套比较基准,各有用途:
  // - resolvedWorkspace:原始形式。相对路径以它为锚点,字符串判断也用它。
  //   Windows 上临时目录常是短路径(8.3 形式),而 realpath 返回长路径,
  //   两者字符串不同但指向同一目录。混用会导致合法路径被误判越界。
  // - realWorkspace:真实路径。符号链接判断用它。
  const comparisonWorkspace = normalizeForComparison(resolvedWorkspace)
  const comparisonRealWorkspace = normalizeForComparison(realWorkspace)

  const resolve = async (requestedPath: string): Promise<string> => {
    const trimmed = requestedPath.trim()
    if (!trimmed) {
      throw new PathOutsideWorkspaceError('路径不能为空', {
        requestedPath,
        resolvedPath: resolvedWorkspace,
        workspace: realWorkspace,
      })
    }

    // 相对路径锚定到工作目录,绝对路径按原样解析
    const resolved = path.resolve(resolvedWorkspace, trimmed)

    // 解析符号链接,拿到真实路径。
    // 这一步同时解决两个问题:软链指向外部,以及 Windows 短路径(8.3 形式)。
    // Windows 上 os.tmpdir() 常返回 C:\Users\RUNNER~1\... 这种短路径,
    // 而 realpath 返回 C:\Users\runneradmin\... 长路径——两者字符串不同
    // 但指向同一目录。只做字符串比较会把合法路径误判成越界。
    const realPath = await resolveRealPath(resolved)

    // 边界检查:真实路径 vs 工作区真实路径。
    // 两边都规范化过,比较才有意义。
    const normalizedRealPath = normalizeForComparison(realPath)
    const insideRealWorkspace = isPathInside(comparisonRealWorkspace, normalizedRealPath)

    if (!insideRealWorkspace) {
      // 兜底:realpath 解析失败时(权限不足、竞态删除等)退回原始路径判断。
      // 只有在路径没被真正解析过的情况下才能用原始路径兜底——
      // 否则软链指向外部时,原始路径看着在工作区内,就越过防线了。
      const realPathUnchanged = realPath === resolved
      const insideRawWorkspace = realPathUnchanged
        && isPathInside(comparisonWorkspace, normalizeForComparison(resolved))

      if (!insideRawWorkspace) {
        throw new PathOutsideWorkspaceError(
          `路径越界,已拒绝访问。目标路径 "${trimmed}" 解析后位于工作目录 "${resolvedWorkspace}" 之外。` +
          `只能访问工作目录内的文件。`,
          {
            requestedPath: trimmed,
            resolvedPath: realPath,
            workspace: realWorkspace,
          },
        )
      }
    }

    return realPath
  }

  const isInside = async (requestedPath: string): Promise<boolean> => {
    try {
      await resolve(requestedPath)
      return true
    } catch {
      return false
    }
  }

  return { workspace: realWorkspace, resolve, isInside }
}

// 把越界错误转成给模型看的文本。
// 模型看到明确提示才知道该改路径,而不是反复重试同一个越界路径。
export function describePathError(error: unknown): string {
  if (error instanceof PathOutsideWorkspaceError) {
    return `error: ${error.message}`
  }
  return `error: ${(error as Error).message}`
}
