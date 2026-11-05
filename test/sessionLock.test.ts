import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 端到端:两个真实进程抢同一个会话文件,第二个必须被拒绝。
// 这是锁机制最关键的场景——进程内的单元测试覆盖不到跨进程竞争。

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function spawnInstance(sessionFilePath: string): { child: ReturnType<typeof spawn>; getOutput: () => string } {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', cliPath],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        GRASSAGENT_SESSION_FILE: sessionFilePath,
        // 必须给 API Key:CI 环境没有 .env,配置校验不过的话进程在启动阶段就退出了,
        // 根本走不到拿锁那步。子进程不会真的调 API,这个 key 只是过校验。
        GRASSAGENT_API_KEY: process.env.GRASSAGENT_API_KEY ?? 'test-key-for-lock-only',
      },
      // stdin 必须保持打开:stdin EOF 会让 readline 关闭、TUI 退出、进程释放锁。
      // 用 'ignore' 的话第一个实例会立刻退出,测不出锁的效果。
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  return { child, getOutput: () => output }
}

// 等待某个条件成立。启动过程里有异步步骤(realpath 解析等),
// 固定 sleep 容易在慢机器上不够用。
async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

test('第二个进程使用同一会话文件时被拒绝', async () => {
  const directory = path.join(os.tmpdir(), `grassagent-lock-${process.pid}-${Date.now()}`)
  await fs.mkdir(directory, { recursive: true })
  const sessionFilePath = path.join(directory, 'session.jsonl')

  const first = spawnInstance(sessionFilePath)
  try {
    // 等第一个实例拿到锁
    const lockAcquired = await waitUntil(
      () => fs.access(`${sessionFilePath}.lock`).then(() => true, () => false),
      15000,
    )
    assert.ok(lockAcquired, '第一个实例应当持有锁文件')
    assert.equal(first.child.exitCode, null, '第一个实例应当还在运行')

    // 第二个实例应当拿不到锁并退出
    const second = spawnInstance(sessionFilePath)
    await new Promise((resolve) => setTimeout(resolve, 9000))

    assert.notEqual(second.child.exitCode, null, '第二个实例应当退出')
    assert.equal(second.child.exitCode, 1)
    assert.ok(
      second.getOutput().includes('被其他进程占用'),
      `错误信息应当说明会话被占用,实际: ${second.getOutput().slice(0, 500)}`,
    )
    second.child.kill()
  } finally {
    first.child.kill()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('不同的会话文件可以同时运行', async () => {
  const directory = path.join(os.tmpdir(), `grassagent-lock-${process.pid}-${Date.now()}-b`)
  await fs.mkdir(directory, { recursive: true })

  const first = spawnInstance(path.join(directory, 'session-a.jsonl'))
  const second = spawnInstance(path.join(directory, 'session-b.jsonl'))

  try {
    const bothRunning = await waitUntil(async () => {
      const firstLock = await fs.access(path.join(directory, 'session-a.jsonl.lock')).then(() => true, () => false)
      const secondLock = await fs.access(path.join(directory, 'session-b.jsonl.lock')).then(() => true, () => false)
      return firstLock && secondLock
    }, 15000)

    assert.ok(bothRunning, '两个实例都应当拿到各自的锁')
    assert.equal(first.child.exitCode, null, '第一个实例应当还在运行')
    assert.equal(second.child.exitCode, null, '第二个实例也应当还在运行')
  } finally {
    first.child.kill()
    second.child.kill()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
