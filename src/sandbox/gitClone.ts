// src/sandbox/gitClone.ts
// 仓库在控制面宿主机上克隆。凭据只活在一次 git 进程里,不写进 URL。
//
// 两种传输:
// - HTTP(S):令牌走 GIT_ASKPASS 的临时脚本,给用户名时回 "git",要口令时回令牌。
// - SSH:凭据是私钥内容,写到 0600 临时文件,通过 GIT_SSH_COMMAND 指定。

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { CommandRunner } from './commandRunner.ts'
import { sandboxProcessEnv, writeSecretFile } from './secrets.ts'

/** 仓库地址用的传输方式。 */
export type RepoTransport = 'http' | 'ssh'

/**
 * 判断仓库地址走哪种传输,顺便把不合规的地址挡掉。
 *
 * scp 风格的 `git@host:path` 不是合法 URL,`new URL()` 会直接抛——
 * 但那是最常见的 SSH 写法,不能当成坏地址。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function classifyRepoUrl(repoUrl: string): RepoTransport {
  const trimmed = repoUrl.trim()
  if (!trimmed) throw new Error('仓库地址不能为空')

  // scp 风格:user@host:path。冒号后面不能是数字开头的端口,
  // 也不能是 //,否则那是 URL 而不是 scp 语法。
  const scpLike = /^[^@\s/]+@[^:\s/]+:(?!\/\/)(?!\d+\/).+$/
  if (scpLike.test(trimmed)) {
    // scp 语法里的 user@ 是正常的 SSH 写法,不是内嵌凭据
    return 'ssh'
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`仓库地址不是合法 URL: ${repoUrl}`)
  }
  if (parsed.protocol === 'ssh:') {
    // ssh://user@host/path 里的 user 也是正常的
    return 'ssh'
  }
  if (parsed.username || parsed.password) {
    throw new Error('仓库地址不能携带凭据,请改用 credentialRef')
  }
  return 'http'
}

/**
 * 把仓库克隆进目标目录。
 *
 * HTTPS 地址带口令会被拒绝,免得口令写进 git 的 remote 配置。
 * SSH 地址允许 user@host 前缀,那是正常的登录名。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function cloneRepository(options: {
  repoUrl: string
  destination: string
  /** HTTPS 传令牌,SSH 传私钥内容。 */
  token: string | null
  runner: CommandRunner
  secretDirectory: string
}): Promise<void> {
  const transport = classifyRepoUrl(options.repoUrl)
  await mkdir(options.secretDirectory, { recursive: true })
  const tokenFile = path.join(options.secretDirectory, 'git-token')
  const askpass = path.join(options.secretDirectory, 'askpass.sh')
  const keyFile = path.join(options.secretDirectory, 'ssh-key')
  try {
    const env = sandboxProcessEnv()
    env.GIT_TERMINAL_PROMPT = '0'

    if (transport === 'http') {
      if (options.token) {
        await writeSecretFile(tokenFile, options.token)
        await writeFile(askpass, ASKPASS, { encoding: 'utf-8', mode: 0o700 })
        await chmod(askpass, 0o700)
        env.GIT_ASKPASS = askpass
        env.GRASS_GIT_TOKEN_FILE = tokenFile
      }
    } else if (options.token) {
      // SSH:凭据是私钥内容。写到 0600 文件,让 ssh 用它。
      await writeSecretFile(keyFile, options.token)
      env.GIT_SSH_COMMAND = sshCommand(keyFile)
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
    await rm(keyFile, { force: true })
  }
}

/**
 * 拼 GIT_SSH_COMMAND。
 *
 * 私钥路径要加引号——路径里有空格的话,git 会把参数拆开。
 * BatchMode 让缺密钥时立刻失败,而不是卡在交互提示上等输入。
 * accept-new 是首次连接信任、之后变化拒绝,和隧道那边的主机密钥策略一致。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
export function sshCommand(keyFilePath: string): string {
  const quoted = `'${keyFilePath.replace(/'/g, `'\\''`)}'`
  return [
    'ssh',
    '-i', quoted,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'IdentitiesOnly=yes',
  ].join(' ')
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s' 'git' ;;
  *) cat "$GRASS_GIT_TOKEN_FILE" ;;
esac
`