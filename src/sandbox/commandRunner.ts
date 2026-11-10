// src/sandbox/commandRunner.ts
// 控制面调 docker 和 git 时不经过 shell,参数不会被再解释一遍。

import { spawn } from 'node:child_process'

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandRunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string
}

export interface CommandRunner {
  /** 执行 argv 并收回退出码。作者：Pieory 创建日期：2025-07-18 */
  run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandResult>
}

const MAX_COMMAND_OUTPUT = 1024 * 1024

/**
 * 用 spawn 跑外部命令。stdout/stderr 超过 1MB 就停,避免 docker 异常输出把控制面撑满。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function createProcessRunner(): CommandRunner {
  return {
    run(argv, options) {
      return new Promise((resolve, reject) => {
        if (argv.length === 0) {
          reject(new Error('命令是空的'))
          return
        }
        const child = spawn(argv[0], argv.slice(1), {
          cwd: options?.cwd,
          env: options?.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBytes += chunk.length
          if (stdoutBytes <= MAX_COMMAND_OUTPUT) stdout.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderrBytes += chunk.length
          if (stderrBytes <= MAX_COMMAND_OUTPUT) stderr.push(chunk)
        })
        child.once('error', reject)
        child.once('close', (code) => {
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout).toString('utf-8'),
            stderr: Buffer.concat(stderr).toString('utf-8'),
          })
        })
        if (options?.stdin !== undefined) child.stdin.end(options.stdin)
        else child.stdin.end()
      })
    },
  }
}
