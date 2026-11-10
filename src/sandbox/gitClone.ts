// src/sandbox/gitClone.ts
// 仓库在控制面宿主机上克隆。令牌只活在一次 git 进程的 askpass 文件里,不写进 URL。

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { CommandRunner } from './commandRunner.ts'
import { sandboxProcessEnv, writeSecretFile } from './secrets.ts'

/**
 * 把仓库克隆进目标目录。地址里已经带了用户名或口令就拒绝。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function cloneRepository(options: {
  repoUrl: string
  destination: string
  token: string | null
  runner: CommandRunner
  secretDirectory: string
}): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(options.repoUrl)
  } catch {
    throw new Error(`仓库地址不是合法 URL: ${options.repoUrl}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('仓库地址不能携带凭据,请改用 credentialRef')
  }
  await mkdir(options.secretDirectory, { recursive: true })
  const tokenFile = path.join(options.secretDirectory, 'git-token')
  const askpass = path.join(options.secretDirectory, 'askpass.sh')
  try {
    if (options.token) {
      await writeSecretFile(tokenFile, options.token)
      await writeFile(askpass, ASKPASS, { encoding: 'utf-8', mode: 0o700 })
      await chmod(askpass, 0o700)
    }
    // 不继承宿主的全部环境。API key 留在 Grass 进程里,git 只拿 PATH 和这次的 askpass。
    const env = sandboxProcessEnv()
    env.GIT_TERMINAL_PROMPT = '0'
    if (options.token) {
      env.GIT_ASKPASS = askpass
      env.GRASS_GIT_TOKEN_FILE = tokenFile
    }
    const result = await options.runner.run(
      ['git', 'clone', '--', options.repoUrl, options.destination],
      { env },
    )
    if (result.exitCode !== 0) {
      await rm(options.destination, { recursive: true, force: true })
      throw new Error(`克隆仓库失败: ${result.stderr || result.stdout || 'git clone 失败'}`)
    }
  } finally {
    await rm(tokenFile, { force: true })
    await rm(askpass, { force: true })
  }
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s' 'git' ;;
  *) cat "$GRASS_GIT_TOKEN_FILE" ;;
esac
`
