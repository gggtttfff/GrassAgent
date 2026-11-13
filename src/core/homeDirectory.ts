// src/core/homeDirectory.ts
// 宿主目录解析。放在 core 而不是 config 里:`.env` 的位置必须先于 `.env` 的内容确定,
// 控制面又是不加载 .env 的独立进程,两边得共用同一套规则而不互相依赖。

import * as path from 'node:path'
import * as os from 'node:os'

export const HOME_ENV_NAME = 'GRASSAGENT_HOME'
export const DEFAULT_HOME_DIRECTORY_NAME = '.grassagent'

/** 没配 GRASSAGENT_HOME 时的根目录。保持和改造前一致,已有会话仍在原处。 */
export function defaultHomeDirectory(homedir: string = os.homedir()): string {
  return path.join(homedir, DEFAULT_HOME_DIRECTORY_NAME)
}

/**
 * 把用户给的目录收敛成绝对路径。
 * ~ 前缀要自己展开:从 .env 或 Windows 环境读进来的值,shell 不一定替我们展开过。
 * 相对路径按启动目录解析;空值回退默认宿主目录,不能让空串把路径指到 cwd 上。
 */
export function resolveHomeDirectory(
  value: string | null | undefined,
  options: { homedir?: string; cwd?: string } = {},
): string {
  const homedir = options.homedir ?? os.homedir()
  const trimmed = value?.trim()
  if (!trimmed) return defaultHomeDirectory(homedir)

  if (trimmed === '~') return path.resolve(homedir)
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.resolve(homedir, trimmed.slice(2))
  }
  return path.resolve(options.cwd ?? process.cwd(), trimmed)
}
