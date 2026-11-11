// src/sandbox/lexicalPath.ts
// 远程客户端先做词法边界检查,省掉一次往返。
// 这里只用 POSIX 规则:沙盒里的根固定是 Linux 路径,不能跟着 Windows 客户端的 path 走。
// 软链要等 daemon 在那台机器上 realpath 之后再拦一次。

import * as path from 'node:path'
import * as posix from 'node:path/posix'
import { PathOutsideWorkspaceError } from '../core/pathGuard.ts'

/** 容器里工作区的固定位置。客户端和 daemon 用同一个字符串做词法判断。 */
export const ADVERTISED_WORKSPACE = '/workspace'

/**
 * 把模型给的路径收成沙盒内的绝对 POSIX 路径。越界抛 PathOutsideWorkspaceError。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function advertisedPath(workspaceRoot: string, requestedPath: string): string {
  const root = posix.resolve(workspaceRoot)
  const trimmed = requestedPath.trim()
  if (!trimmed) {
    throw new PathOutsideWorkspaceError('路径不能为空', {
      requestedPath,
      resolvedPath: root,
      workspace: root,
    })
  }
  const resolved = posix.resolve(root, trimmed)
  if (!isPosixInside(root, resolved)) {
    throw new PathOutsideWorkspaceError(
      `路径越界,已拒绝访问。目标路径 "${trimmed}" 解析后位于工作目录 "${root}" 之外。只能访问工作目录内的文件。`,
      { requestedPath: trimmed, resolvedPath: resolved, workspace: root },
    )
  }
  return resolved
}

/**
 * danger-full-access 用的宽松版:只把相对路径补成绝对路径,不做越界判断。
 *
 * 工作区内的路径照样落在 /workspace 下,和工作区模式看到的路径一致;
 * 绝对路径原样放行,交给 daemon 在那台机器上判断它是不是真存在。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function advertisedPathLoose(workspaceRoot: string, requestedPath: string): string {
  const root = posix.resolve(workspaceRoot)
  const trimmed = requestedPath.trim()
  if (!trimmed) {
    throw new PathOutsideWorkspaceError('路径不能为空', {
      requestedPath,
      resolvedPath: root,
      workspace: root,
    })
  }
  return posix.resolve(root, trimmed)
}

/**
 * 把对外的 /workspace/... 映射到 daemon 这台机器上的真实目录。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function localPathFromAdvertised(
  advertisedRoot: string,
  advertisedFile: string,
  localRoot: string,
): string {
  const relative = posix.relative(posix.resolve(advertisedRoot), advertisedFile)
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
    throw new PathOutsideWorkspaceError(
      `路径越界,已拒绝访问。目标路径 "${advertisedFile}" 解析后位于工作目录 "${advertisedRoot}" 之外。只能访问工作目录内的文件。`,
      { requestedPath: advertisedFile, resolvedPath: advertisedFile, workspace: advertisedRoot },
    )
  }
  const parts = relative === '' ? [] : relative.split('/')
  return path.resolve(localRoot, ...parts)
}

/**
 * 临时文件在本机的路径要写成沙盒里的路径,模型下一轮才读得到。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function advertisedFromLocal(
  localRoot: string,
  advertisedRoot: string,
  localFile: string,
): string {
  const relative = path.relative(localRoot, localFile)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PathOutsideWorkspaceError(
      `路径越界,已拒绝访问。目标路径 "${localFile}" 解析后位于工作目录 "${localRoot}" 之外。只能访问工作目录内的文件。`,
      { requestedPath: localFile, resolvedPath: localFile, workspace: localRoot },
    )
  }
  const parts = relative === '' ? [] : relative.split(path.sep)
  return posix.join(advertisedRoot, ...parts)
}

/**
 * 判断一个对外路径是否落在工作区根下。danger 模式下用它区分
 * 「工作区里的文件」(要映射) 和「这台机器上的其他路径」(原样放行)。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function isAdvertisedInside(advertisedRoot: string, target: string): boolean {
  return isPosixInside(posix.resolve(advertisedRoot), posix.resolve(target))
}

function isPosixInside(root: string, target: string): boolean {
  const relative = posix.relative(root, target)
  if (relative === '') return true
  if (relative === '..' || relative.startsWith('../')) return false
  if (posix.isAbsolute(relative)) return false
  return true
}
