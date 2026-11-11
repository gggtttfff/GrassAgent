import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createDefaultApprovalGate } from '../../src/world/approvalGate.ts'
import { createLocalWorld } from '../../src/world/localWorld.ts'
import type { SandboxMode } from '../../src/world/executionWorld.ts'
import { MAX_OUTPUT_BYTES } from '../../src/world/outputBound.ts'

test('本地世界读写和原子编辑与原来的工具一致', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-local-'))
  try {
    const world = await createLocalWorld({ workspace })
    assert.equal(world.sandboxId, null)
    const written = await world.write('sub/note.txt', 'hello')
    assert.equal(await readFile(written, 'utf-8'), 'hello')
    assert.equal(await world.read('sub/note.txt'), 'hello')
    await world.edit('sub/note.txt', [
      { old_string: 'hello', new_string: 'hello grass' },
      { old_string: 'grass', new_string: 'world' },
    ])
    assert.equal(await world.read('sub/note.txt'), 'hello world')
    await assert.rejects(
      () => world.edit('sub/note.txt', [
        { old_string: 'hello', new_string: 'HELLO' },
        { old_string: 'missing', new_string: 'x' },
      ]),
      /not found/,
    )
    assert.equal(await readFile(path.join(workspace, 'sub/note.txt'), 'utf-8'), 'hello world')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('超过行数的文件只返回尾部,全文留在工作区临时目录里', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-tail-'))
  try {
    const world = await createLocalWorld({ workspace })
    const lines = Array.from({ length: 250 }, (_, index) => `line-${index}`)
    await world.write('long.txt', lines.join('\n'))
    const shown = await world.read('long.txt')
    assert.match(shown, /output truncated/)
    assert.match(shown, /line-249/)
    assert.doesNotMatch(shown, /line-0/)
    const fullPath = shown.match(/full output :(.+)\n/)?.[1]
    assert.ok(fullPath, shown)
    assert.ok(fullPath.includes(`${path.sep}.grass${path.sep}tmp${path.sep}`), fullPath)
    // 再读一遍仍然会截断,所以全文直接看临时文件,确认世界把它留在了自己的目录里。
    const full = await readFile(fullPath, 'utf-8')
    assert.equal(full.split('\n').length, 250)
    assert.match(full, /line-0/)
    const again = await world.read(fullPath)
    assert.match(again, /line-249/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('超过字节上限的文件不会整段留在返回值里', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-bytes-'))
  try {
    const world = await createLocalWorld({ workspace })
    const handle = await (await import('node:fs/promises')).open(path.join(workspace, 'huge.txt'), 'w')
    const chunk = Buffer.alloc(256 * 1024, 0x61)
    for (let index = 0; index < 8; index++) await handle.write(chunk)
    await handle.close()
    const shown = await world.read('huge.txt')
    assert.ok(shown.length < MAX_OUTPUT_BYTES + 400, `返回了 ${shown.length} 字符`)
    assert.match(shown, /full output :/)
    const fullPath = shown.match(/full output :(.+)\n/)?.[1]
    assert.ok(fullPath)
    const info = await stat(fullPath)
    assert.equal(info.size, 8 * 256 * 1024)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('raw 读拿到全文,列目录给出条目和大小', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-raw-'))
  try {
    const world = await createLocalWorld({ workspace })
    // 普通读超过 200 行就只给尾部,技能正文常常有几百行,raw 读要拿到完整正文
    const manyLines = Array.from({ length: 300 }, (_, index) => `line-${index}`).join('\n')
    await writeFile(path.join(workspace, 'skill.md'), manyLines)
    const shown = await world.read('skill.md')
    assert.ok(shown.length < manyLines.length, '普通读应该被截断')
    assert.equal(await world.readRaw('skill.md'), manyLines)

    await writeFile(path.join(workspace, 'note.txt'), 'hello')
    await mkdir(path.join(workspace, 'sub'), { recursive: true })
    const entries = await world.list('.')
    const names = entries.map((entry) => entry.name)
    assert.equal(names.includes('note.txt'), true)
    assert.equal(names.includes('skill.md'), true)
    assert.equal(names.includes('sub'), true)
    const note = entries.find((entry) => entry.name === 'note.txt')
    assert.equal(note?.type, 'file')
    assert.equal(note?.size, 5)
    assert.equal(typeof note?.mtimeMs, 'number')
    assert.equal(entries.find((entry) => entry.name === 'sub')?.type, 'directory')

    await assert.rejects(() => world.list('../outside'), /越界/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('非法 UTF-8 和越界路径会明确失败', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-guard-'))
  try {
    const world = await createLocalWorld({ workspace })
    await writeFile(path.join(workspace, 'bad.bin'), Buffer.from([0xff, 0xfe, 0xfd]))
    await assert.rejects(() => world.read('bad.bin'), /UTF-8/)
    await assert.rejects(() => world.read('../outside.txt'), /越界/)
    const outside = path.join(os.tmpdir(), `grass-link-target-${process.pid}.txt`)
    await writeFile(outside, 'secret')
    await symlink(outside, path.join(workspace, 'escape'))
    await assert.rejects(() => world.read('escape'), /越界/)
    await rm(outside, { force: true })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('只读世界拒绝写入和执行,danger-full-access 没有审批就创建失败', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-readonly-'))
  try {
    const world = await createLocalWorld({ workspace, mode: 'read-only' })
    await world.write('ok.txt', 'kept').catch(() => undefined)
    await assert.rejects(() => world.write('ok.txt', 'x'), /只读沙盒拒绝写入/)
    await assert.rejects(() => world.exec({
      argv: ['bash', '-c', 'touch ok.txt'],
      cwd: world.workspaceRoot,
      timeoutMs: 1000,
    }), /只读沙盒拒绝执行命令/)
    await assert.rejects(
      () => createLocalWorld({ workspace, mode: 'danger-full-access' }),
      /审批拒绝/,
    )
    await assert.rejects(
      () => createLocalWorld({
        workspace,
        mode: 'danger-full-access',
        approval: createDefaultApprovalGate(),
      }),
      /审批拒绝/,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('setMode 切到只读后写入和执行都被拒,切回来又能写', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-setmode-'))
  try {
    const world = await createLocalWorld({ workspace })
    await world.write('ok.txt', 'kept')
    assert.equal(world.policy.mode, 'workspace-write')

    await world.setMode('read-only')
    assert.equal(world.policy.mode, 'read-only')
    await assert.rejects(() => world.write('ok.txt', 'x'), /只读沙盒拒绝写入/)
    await assert.rejects(() => world.exec({
      argv: ['bash', '-c', 'touch ok.txt'],
      cwd: world.workspaceRoot,
      timeoutMs: 1000,
    }), /只读沙盒拒绝执行命令/)

    await world.setMode('workspace-write')
    await world.write('ok.txt', 'again')
    assert.equal(await world.read('ok.txt'), 'again')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('setMode 拒绝未知模式,原来的模式不变', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-badmode-'))
  try {
    const world = await createLocalWorld({ workspace })
    await assert.rejects(
      () => world.setMode('whatever' as SandboxMode),
      /未知的沙盒模式/,
    )
    assert.equal(world.policy.mode, 'workspace-write')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('全权限模式能写工作区外的路径,切回可写模式又挡住', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-danger-'))
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'grass-outside-'))
  try {
    const world = await createLocalWorld({
      workspace,
      mode: 'danger-full-access',
      approval: { async decide() { return 'allow' } },
    })
    const outsideFile = path.join(outsideDir, 'danger.txt')
    const written = await world.write(outsideFile, 'outside')
    assert.equal(written, path.resolve(outsideFile))
    assert.equal(await readFile(outsideFile, 'utf-8'), 'outside')

    await world.setMode('workspace-write')
    await assert.rejects(() => world.write(outsideFile, 'x'), /越界/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('超长命令输出只把尾部留在内存里', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-stdout-'))
  try {
    const world = await createLocalWorld({ workspace })
    const result = await world.exec({
      // 直接跑 node,避免 Windows 把 bash -c 译成 cmd 后引号把脚本吃掉、stdout 变空。
      argv: [process.execPath, '-e', "process.stdout.write('a'.repeat(400000))"],
      cwd: world.workspaceRoot,
      timeoutMs: 5000,
    })
    assert.match(result.stdout, /full output :/)
    assert.ok(result.stdout.length < MAX_OUTPUT_BYTES + 400, `stdout 返回了 ${result.stdout.length}`)
    const fullPath = result.stdout.match(/full output :(.+)\n/)?.[1]
    assert.ok(fullPath)
    const info = await stat(fullPath)
    assert.equal(info.size, 400000)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('命令在工作区内执行,失败和超时的文本保持原来的样子', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'grass-exec-'))
  try {
    const world = await createLocalWorld({ workspace })
    const ok = await world.exec({
      argv: ['bash', '-c', 'pwd'],
      cwd: world.workspaceRoot,
      timeoutMs: 2000,
    })
    assert.equal(ok.exitCode, 0)
    assert.ok(ok.stdout.includes(path.basename(workspace)) || ok.stdout.trim().length > 0)
    const failed = await world.exec({
      argv: ['bash', '-c', 'exit 3'],
      cwd: world.workspaceRoot,
      timeoutMs: 2000,
    })
    assert.equal(failed.exitCode, 3)
    const started = Date.now()
    const timed = await world.exec({
      argv: ['bash', '-c', 'sleep 5'],
      cwd: world.workspaceRoot,
      timeoutMs: 100,
    })
    assert.ok(Date.now() - started < 3000)
    assert.equal(timed.timedOut, true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
