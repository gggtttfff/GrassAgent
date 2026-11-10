import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as os from 'node:os'
import { promises as fs } from 'node:fs'
import { createPathGuard, PathOutsideWorkspaceError } from '../../src/core/pathGuard.ts'

const workspace = path.resolve('/tmp/workspace')

test('工作目录内的相对路径可以解析', async () => {
  const guard = await createPathGuard(workspace)
  assert.equal(await guard.resolve('src/index.ts'), path.join(workspace, 'src/index.ts'))
})

test('工作目录内的父级相对路径可以解析', async () => {
  const guard = await createPathGuard(workspace)
  assert.equal(await guard.resolve('./a/../b.txt'), path.join(workspace, 'b.txt'))
})

test('工作目录本身可以解析', async () => {
  const guard = await createPathGuard(workspace)
  assert.equal(await guard.resolve('.'), workspace)
})

test('越界的父级路径被拒绝', async () => {
  const guard = await createPathGuard(workspace)
  await assert.rejects(() => guard.resolve('../outside.txt'), PathOutsideWorkspaceError)
})

test('越界的深层父级路径被拒绝', async () => {
  const guard = await createPathGuard(workspace)
  await assert.rejects(() => guard.resolve('../../etc/passwd'), PathOutsideWorkspaceError)
})

test('绝对路径在工作目录外被拒绝', async () => {
  const guard = await createPathGuard(workspace)
  await assert.rejects(() => guard.resolve('/etc/passwd'), PathOutsideWorkspaceError)
})

test('同前缀的兄弟目录被拒绝', async () => {
  const guard = await createPathGuard(workspace)
  const sibling = `${workspace}-other/file.txt`
  await assert.rejects(() => guard.resolve(sibling), PathOutsideWorkspaceError)
})

test('空路径被拒绝', async () => {
  const guard = await createPathGuard(workspace)
  await assert.rejects(() => guard.resolve('   '), PathOutsideWorkspaceError)
})

test('isInside 不抛错', async () => {
  const guard = await createPathGuard(workspace)
  assert.equal(await guard.isInside('src/a.ts'), true)
  assert.equal(await guard.isInside('../a.ts'), false)
})

test('越界错误的提示里带有工作目录', async () => {
  const guard = await createPathGuard(workspace)
  try {
    await guard.resolve('../secret.txt')
    assert.fail('应当抛出 PathOutsideWorkspaceError')
  } catch (error) {
    assert.ok(error instanceof PathOutsideWorkspaceError)
    assert.ok(error.message.includes(workspace))
    assert.equal(error.workspace, workspace)
  }
})

// ---- 符号链接 ----

test('符号链接指向工作区外时被拒绝', async () => {
  const root = path.join(os.tmpdir(), `grassagent-symlink-${process.pid}-${Date.now()}`)
  const outside = path.join(root, 'outside')
  const work = path.join(root, 'work')
  await fs.mkdir(outside, { recursive: true })
  await fs.mkdir(work, { recursive: true })

  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), '机密内容', 'utf-8')
    await fs.symlink(outside, path.join(work, 'link'), 'junction')

    const guard = await createPathGuard(work)
    // 路径字符串看起来在工作区内,但真实路径在外面
    await assert.rejects(
      () => guard.resolve(path.join('link', 'secret.txt')),
      PathOutsideWorkspaceError,
    )
    assert.equal(await guard.isInside(path.join('link', 'secret.txt')), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('符号链接指向工作区内时被允许', async () => {
  const root = path.join(os.tmpdir(), `grassagent-sym-ok-${process.pid}-${Date.now()}`)
  const work = path.join(root, 'work')
  // 目标目录必须在工作区内部,否则真实路径本来就在界外
  const inner = path.join(work, 'inner')
  await fs.mkdir(inner, { recursive: true })

  try {
    await fs.writeFile(path.join(inner, 'ok.txt'), '正常内容', 'utf-8')
    await fs.symlink(inner, path.join(work, 'alias'), 'junction')

    const guard = await createPathGuard(work)
    const resolved = await guard.resolve(path.join('alias', 'ok.txt'))
    // 返回的是解析后的真实路径,不含符号链接那一层
    assert.ok(!resolved.includes('alias'), `应返回真实路径,实际 ${resolved}`)
    assert.equal(await fs.readFile(resolved, 'utf-8'), '正常内容')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('工作区路径与 realpath 不同时仍能正常访问', async () => {
  // Windows CI 上 os.tmpdir() 返回短路径(8.3 形式,如 C:\Users\RUNNER~1\...),
  // 而 realpath 返回长路径(C:\Users\runneradmin\...)。两者字符串不同但指向同一目录。
  // 这里用符号链接制造同样的情况:工作区用链接路径,请求用真实路径,反之亦然。
  const root = path.join(os.tmpdir(), `grassagent-shortpath-${process.pid}-${Date.now()}`)
  const realDir = path.join(root, 'real')
  const aliasDir = path.join(root, 'alias')
  await fs.mkdir(realDir, { recursive: true })

  try {
    await fs.writeFile(path.join(realDir, 'file.txt'), '内容', 'utf-8')
    await fs.symlink(realDir, aliasDir, 'junction')

    // 工作区用符号链接路径(模拟短路径场景)
    const guard = await createPathGuard(aliasDir)

    // 工作区内的相对路径要能访问
    const resolved = await guard.resolve('file.txt')
    assert.equal(await fs.readFile(resolved, 'utf-8'), '内容')

    // 工作区内的绝对路径(用符号链接形式)也要能访问
    const absoluteViaAlias = await guard.resolve(path.join(aliasDir, 'file.txt'))
    assert.equal(await fs.readFile(absoluteViaAlias, 'utf-8'), '内容')

    // 工作区内的绝对路径(用真实路径形式)也要能访问
    const viaReal = await guard.resolve(path.join(realDir, 'file.txt'))
    assert.equal(await fs.readFile(viaReal, 'utf-8'), '内容')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('软链指向外部时即使有原始路径兜底也不能放行', async () => {
  // 回归测试:曾经有一版实现里,软链解析失败后的兜底判断会放行越界路径。
  // 兜底只在路径没被真正解析过时才允许生效。
  const root = path.join(os.tmpdir(), `grassagent-fallback-${process.pid}-${Date.now()}`)
  const outside = path.join(root, 'outside')
  const work = path.join(root, 'work')
  await fs.mkdir(outside, { recursive: true })
  await fs.mkdir(work, { recursive: true })

  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), '机密', 'utf-8')
    await fs.symlink(outside, path.join(work, 'alias'), 'junction')

    const guard = await createPathGuard(work)
    await assert.rejects(
      () => guard.resolve(path.join('alias', 'secret.txt')),
      PathOutsideWorkspaceError,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('工作区本身是符号链接时不会被误判越界', async () => {  const root = path.join(os.tmpdir(), `grassagent-symlink-ws-${process.pid}-${Date.now()}`)
  const real = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  await fs.mkdir(real, { recursive: true })

  try {
    await fs.symlink(real, alias, 'junction')
    // 用符号链接路径作为工作区
    const guard = await createPathGuard(alias)
    const resolved = await guard.resolve('file.txt')
    assert.ok(resolved.startsWith(await fs.realpath(real)), `实际 ${resolved}`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('目标文件不存在时按最近存在的祖先判断边界', async () => {
  const root = path.join(os.tmpdir(), `grassagent-symlink-new-${process.pid}-${Date.now()}`)
  const outside = path.join(root, 'outside')
  const work = path.join(root, 'work')
  await fs.mkdir(outside, { recursive: true })
  await fs.mkdir(work, { recursive: true })

  try {
    await fs.symlink(outside, path.join(work, 'link'), 'junction')
    const guard = await createPathGuard(work)
    // 目标还不存在,但父目录里的符号链接要能识破
    await assert.rejects(
      () => guard.resolve(path.join('link', 'new-file.txt')),
      PathOutsideWorkspaceError,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
