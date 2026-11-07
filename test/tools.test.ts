import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as os from 'node:os'
import { promises as fs } from 'node:fs'
import { builtinTools } from '../src/tools.ts'
import { createPathGuard } from '../src/pathGuard.ts'
import type { AgentTool } from '../src/agent.ts'

const workDir = path.join(os.tmpdir(), `grassagent-tools-${process.pid}`)

// builtinTools 现在是异步的(要先解析工作区的真实路径才能做沙箱判断)
let cachedTools: AgentTool[] | undefined

async function findTool(name: string): Promise<AgentTool> {
  cachedTools ??= await builtinTools({ workspace: workDir })
  const tool = cachedTools.find((item) => item.name === name)
  assert.ok(tool, `未找到工具 ${name}`)
  return tool
}

test('read_file 能读取工作区内的文件', async () => {
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'read.txt'), 'hello', 'utf-8')
  const result = await (await findTool('read_file')).execute({ path: 'read.txt' })
  assert.equal(result, 'hello')
})

test('read_file 拒绝工作区外的路径', async () => {
  const result = await (await findTool('read_file')).execute({ path: '../../../etc/passwd' })
  assert.ok(result.startsWith('error:'), `实际: ${result}`)
  assert.ok(result.includes('越界'), `实际: ${result}`)
})

test('read_file 拒绝绝对路径越界', async () => {
  const result = await (await findTool('read_file')).execute({ path: path.resolve(os.tmpdir(), 'outside.txt') })
  assert.ok(result.startsWith('error:'), `实际: ${result}`)
})

test('write_file 写入工作区内文件', async () => {
  await fs.mkdir(workDir, { recursive: true })
  const result = await (await findTool('write_file')).execute({ path: 'sub/dir/new.txt', content: '内容' })
  assert.ok(result.startsWith('wrote '), `实际: ${result}`)
  const written = await fs.readFile(path.join(workDir, 'sub/dir/new.txt'), 'utf-8')
  assert.equal(written, '内容')
})

test('write_file 拒绝写入工作区外', async () => {
  const outsidePath = path.join(os.tmpdir(), `grassagent-escape-${process.pid}.txt`)
  const result = await (await findTool('write_file')).execute({ path: outsidePath, content: 'x' })
  assert.ok(result.startsWith('error:'), `实际: ${result}`)
  await fs.rm(outsidePath, { force: true })
})

test('edit 替换唯一匹配的文本', async () => {
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'edit.txt'), 'hello world', 'utf-8')
  const result = await (await findTool('edit')).execute({
    path: 'edit.txt',
    old_string: 'world',
    new_string: 'grass',
  })
  assert.ok(result.startsWith('edited '), `实际: ${result}`)
  assert.equal(await fs.readFile(path.join(workDir, 'edit.txt'), 'utf-8'), 'hello grass')
})

test('edit 在多处匹配时报错', async () => {
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'dup.txt'), 'aXbXc', 'utf-8')
  const result = await (await findTool('edit')).execute({
    path: 'dup.txt',
    old_string: 'X',
    new_string: 'Y',
  })
  assert.ok(result.includes('matches 2 places'), `实际: ${result}`)
  assert.equal(await fs.readFile(path.join(workDir, 'dup.txt'), 'utf-8'), 'aXbXc', '失败时不应改动文件')
})

test('edit 在找不到目标时报错', async () => {
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'none.txt'), 'abc', 'utf-8')
  const result = await (await findTool('edit')).execute({
    path: 'none.txt',
    old_string: 'zzz',
    new_string: 'Y',
  })
  assert.ok(result.includes('not found'), `实际: ${result}`)
})

test('edit 的 old_string 为空串时报错而不是匹配整篇', async () => {
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'empty.txt'), 'abc', 'utf-8')
  const result = await (await findTool('edit')).execute({
    path: 'empty.txt',
    old_string: '',
    new_string: 'Y',
  })
  assert.ok(result.includes('not found'), `实际: ${result}`)
})

test('edit 拒绝修改工作区外的文件', async () => {
  const outsidePath = path.join(os.tmpdir(), `grassagent-escape-edit-${process.pid}.txt`)
  await fs.writeFile(outsidePath, 'abc', 'utf-8')
  const result = await (await findTool('edit')).execute({
    path: outsidePath,
    old_string: 'abc',
    new_string: 'xyz',
  })
  assert.ok(result.startsWith('error:'), `实际: ${result}`)
  assert.equal(await fs.readFile(outsidePath, 'utf-8'), 'abc', '越界时不应改动文件')
  await fs.rm(outsidePath, { force: true })
})

test('edit_batch 一次替换多处', async () => {
  await fs.mkdir(workDir, { recursive: true })
  const filePath = path.join(workDir, 'batch.txt')
  await fs.writeFile(filePath, 'alpha beta gamma', 'utf-8')
  const result = await (await findTool('edit_batch')).execute({
    path: 'batch.txt',
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'gamma', new_string: 'GAMMA' },
    ],
  })
  assert.ok(result.startsWith('edited '), `实际: ${result}`)
  assert.equal(await fs.readFile(filePath, 'utf-8'), 'ALPHA beta GAMMA')
})

test('edit_batch 按顺序应用,后一项基于前一项的结果', async () => {
  await fs.mkdir(workDir, { recursive: true })
  const filePath = path.join(workDir, 'sequential.txt')
  await fs.writeFile(filePath, 'A', 'utf-8')
  // 第一项把 A 改成 B,第二项再把 B 改成 C。
  // 如果是"对着原文同时替换"而不是顺序应用,第二项会找不到 B。
  await (await findTool('edit_batch')).execute({
    path: 'sequential.txt',
    edits: [
      { old_string: 'A', new_string: 'B' },
      { old_string: 'B', new_string: 'C' },
    ],
  })
  assert.equal(await fs.readFile(filePath, 'utf-8'), 'C')
})

test('edit_batch 中任一项失败则文件保持原样', async () => {
  await fs.mkdir(workDir, { recursive: true })
  const filePath = path.join(workDir, 'atomic.txt')
  const original = 'alpha beta'
  await fs.writeFile(filePath, original, 'utf-8')
  const result = await (await findTool('edit_batch')).execute({
    path: 'atomic.txt',
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'zzz', new_string: 'ZZZ' },
    ],
  })
  assert.ok(result.includes('找不到'), `实际: ${result}`)
  // 原子性:第一项虽然匹配成功,但整批不写入
  assert.equal(await fs.readFile(filePath, 'utf-8'), original, '失败时不应改动文件')
})

test('edit_batch 中某项匹配多处时报错并保持原样', async () => {
  await fs.mkdir(workDir, { recursive: true })
  const filePath = path.join(workDir, 'dup-batch.txt')
  const original = 'aXbXc'
  await fs.writeFile(filePath, original, 'utf-8')
  const result = await (await findTool('edit_batch')).execute({
    path: 'dup-batch.txt',
    edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'X', new_string: 'Y' },
    ],
  })
  assert.ok(result.includes('必须唯一'), `实际: ${result}`)
  assert.equal(await fs.readFile(filePath, 'utf-8'), original, '失败时不应改动文件')
})

test('edit_batch 的错误信息标出是第几处出的问题', async () => {
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'index.txt'), 'alpha beta', 'utf-8')
  const result = await (await findTool('edit_batch')).execute({
    path: 'index.txt',
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'zzz', new_string: 'ZZZ' },
    ],
  })
  assert.ok(result.includes('第 2 处'), `实际: ${result}`)
})

test('edit_batch 拒绝修改工作区外的文件', async () => {
  const outsidePath = path.join(os.tmpdir(), `grassagent-escape-batch-${process.pid}.txt`)
  await fs.writeFile(outsidePath, 'abc', 'utf-8')
  const result = await (await findTool('edit_batch')).execute({
    path: outsidePath,
    edits: [{ old_string: 'abc', new_string: 'xyz' }],
  })
  assert.ok(result.startsWith('error:'), `实际: ${result}`)
  assert.equal(await fs.readFile(outsidePath, 'utf-8'), 'abc', '越界时不应改动文件')
  await fs.rm(outsidePath, { force: true })
})

test('edit_batch 声明了 mutatesFiles,同一文件的并发写会排队', async () => {
  await fs.mkdir(workDir, { recursive: true })
  const tool = await findTool('edit_batch')
  assert.deepEqual(tool.mutatesFiles, ['path'])
})

test('run_bash 在工作区内执行', async () => {
  await fs.mkdir(workDir, { recursive: true })
  await fs.writeFile(path.join(workDir, 'cwd-check.txt'), 'x', 'utf-8')
  const result = await (await findTool('run_bash')).execute({ command: 'ls cwd-check.txt' })
  assert.ok(result.includes('cwd-check.txt'), `实际: ${result}`)
})

test('run_bash 的工作目录锁定在工作区', async () => {
  await fs.mkdir(workDir, { recursive: true })
  const guard = await createPathGuard(workDir)
  const result = await (await findTool('run_bash')).execute({ command: 'pwd' })
  // 平台的 pwd 输出可能是 /private/var 之类(符号链接已解析),这里只校验在工作区内
  assert.ok(result.trim().length > 0)
  assert.ok(
    await guard.isInside(result.trim()) || result.includes(path.basename(workDir)),
    `实际: ${result}`,
  )
})

test('run_bash 命令失败时返回退出码', async () => {
  const result = await (await findTool('run_bash')).execute({ command: 'exit 3' })
  assert.ok(result.includes('exit 3'), `实际: ${result}`)
})

test('run_bash 的超时时间可配置', async () => {
  await fs.mkdir(workDir, { recursive: true })
  // 超时设成 100ms,执行一个远超这个时长的命令
  const tools = await builtinTools({ workspace: workDir, commandTimeoutMs: 100 })
  const runBash = tools.find((tool) => tool.name === 'run_bash')
  assert.ok(runBash)

  const startedAt = Date.now()
  const result = await runBash.execute({ command: 'sleep 5' })
  const elapsed = Date.now() - startedAt

  // 超时后命令被杀,返回的错误里应能看出是被杀掉的
  assert.ok(elapsed < 3000, `应在超时后很快返回,实际 ${elapsed}ms`)
  assert.ok(result.includes('exit') || result.includes('SIGTERM'), `实际: ${result}`)
})

test('清理测试工作目录', async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})
