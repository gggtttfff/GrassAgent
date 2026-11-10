// src/version.ts
// 版本号只有一个来源:package.json。
// 别在代码里再写一份,不然发版时总有一处忘了改。

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJson } from './jsonSafety.ts'

/** 读不到版本号时的兜底。发版流程坏了不该让程序起不来。 */
const FALLBACK_VERSION = '0.0.0'

/**
 * 从 package.json 读版本号。
 *
 * src/version.ts 和编译后的 dist/version.js 都在项目根下一层,
 * 往上找一级就能拿到 package.json。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function readVersion(): string {
  const packagePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'package.json',
  )
  try {
    const parsed = parseJson(readFileSync(packagePath, 'utf-8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim()
    }
    return FALLBACK_VERSION
  } catch {
    // 打包方式变了、文件被挪走都会读不到。别让它挡住启动。
    return FALLBACK_VERSION
  }
}