import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createPathGuard, PathOutsideWorkspaceError } from '../../src/core/pathGuard.ts'

// 回归测试:Windows 短路径 + 工作区目录尚不存在时,不能误判越界。
//
// 场景还原(Windows CI 上真实发生过):
//   os.tmpdir() 返回短路径   C:\Users\RUNNER~1\AppData\Local\Temp
//   fs.realpath 返回长路径   C:\Users\runneradmin\AppData\Local\Temp
//   两者字符串不同但指向同一目录
//
// 工作区目录还不存在时,fs.realpath(workspace) 会失败,工作区就保留了短路径形式;
// 而请求路径的 realpath 能解析出长路径。两边形式不一致,合法路径被判越界。
//
// 这里用符号链接制造同样的情况:工作区走链接路径,请求走真实路径。

test('工作区不存在时,短路径形式与真实路径形式都能访问', async () => {
  const root = path.join(os.tmpdir(), `grassagent-shortws-${process.pid}-${Date.now()}`)
  const longRoot = path.join(root, 'long')
  await fs.mkdir(longRoot, { recursive: true })

  try {
    const shortRoot = path.join(root, 'short')
    await fs.symlink(longRoot, shortRoot, 'junction')

    // 工作区指向尚不存在的子目录,和 e2e 的 WORK_DIR 一样
    const workspace = path.join(shortRoot, 'not-created-yet')
    const guard = await createPathGuard(workspace)

    // 请求路径的父目录存在,目标文件不存在
    const requestPath = path.join(workspace, 'file.txt')
    const resolved = await guard.resolve(requestPath)
    assert.ok(resolved.length > 0, '应当能解析出真实路径')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('工作区不存在且用真实路径形式请求时也能访问', async () => {
  const root = path.join(os.tmpdir(), `grassagent-shortws2-${process.pid}-${Date.now()}`)
  const longRoot = path.join(root, 'long')
  await fs.mkdir(longRoot, { recursive: true })

  try {
    const shortRoot = path.join(root, 'short')
    await fs.symlink(longRoot, shortRoot, 'junction')

    const workspace = path.join(shortRoot, 'not-created-yet')
    const guard = await createPathGuard(workspace)

    // 用真实路径形式请求
    const realWorkspace = path.join(await fs.realpath(longRoot), 'not-created-yet')
    const resolved = await guard.resolve(path.join(realWorkspace, 'file.txt'))
    assert.ok(resolved.length > 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('工作区不存在时,真正越界的路径仍被拒绝', async () => {
  const root = path.join(os.tmpdir(), `grassagent-shortws3-${process.pid}-${Date.now()}`)
  const longRoot = path.join(root, 'long')
  await fs.mkdir(longRoot, { recursive: true })

  try {
    const shortRoot = path.join(root, 'short')
    await fs.symlink(longRoot, shortRoot, 'junction')

    const workspace = path.join(shortRoot, 'not-created-yet')
    const guard = await createPathGuard(workspace)

    // 指向工作区外的路径必须被拒
    await assert.rejects(
      () => guard.resolve(path.join(shortRoot, '..', '..', 'elsewhere', 'file.txt')),
      PathOutsideWorkspaceError,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
