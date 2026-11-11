import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DangerousCommandsError,
  defaultDangerousCommandsPath,
  findDangerousCommand,
  formatDangerousCommandRejection,
  loadDangerousCommandsFile,
} from '../../src/agent/dangerousCommands.ts'

async function writeRules(directory: string, content: string): Promise<string> {
  await mkdir(path.join(directory, '.grass'), { recursive: true })
  const filePath = path.join(directory, '.grass', 'dangerous-commands.json')
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

test('文件不存在就等于没有规则', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-rules-'))
  try {
    const rules = await loadDangerousCommandsFile(defaultDangerousCommandsPath(directory))
    assert.deepEqual(rules, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('规则读出来能匹配命令', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-rules-'))
  try {
    const filePath = await writeRules(directory, JSON.stringify({
      commands: [
        { pattern: '\\brm\\s+-[a-zA-Z]*r', reason: '禁止递归删除' },
        { pattern: 'mkfs', reason: '禁止格式化磁盘' },
      ],
    }))
    const rules = await loadDangerousCommandsFile(filePath)
    assert.equal(rules.length, 2)
    assert.ok(findDangerousCommand(rules, 'rm -rf /tmp/x'))
    assert.ok(findDangerousCommand(rules, 'sudo mkfs.ext4 /dev/sda'))
    assert.equal(findDangerousCommand(rules, 'ls -la'), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('JSON 坏了要报错,不能当成没有规则', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-rules-'))
  try {
    const filePath = await writeRules(directory, '{ 这不是 JSON')
    await assert.rejects(
      () => loadDangerousCommandsFile(filePath),
      (error: unknown) => {
        assert.ok(error instanceof DangerousCommandsError)
        assert.match(error.message, /不是合法 JSON/)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('schema 不对要报错', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-rules-'))
  try {
    const filePath = await writeRules(directory, JSON.stringify({
      commands: [{ pattern: 'rm', unexpected: 1 }],
    }))
    await assert.rejects(
      () => loadDangerousCommandsFile(filePath),
      (error: unknown) => {
        assert.ok(error instanceof DangerousCommandsError)
        assert.match(error.message, /校验失败/)
        return true
      },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pattern 不是合法正则时报出是哪一条', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-rules-'))
  try {
    const filePath = await writeRules(directory, JSON.stringify({
      commands: [{ pattern: '([unclosed' }],
    }))
    await assert.rejects(
      () => loadDangerousCommandsFile(filePath),
      /不是合法正则/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('拒绝理由里带上规则和规则文件路径', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-rules-'))
  try {
    const filePath = await writeRules(directory, JSON.stringify({
      commands: [{ pattern: 'rm -rf', reason: '禁止递归删除' }],
    }))
    const rules = await loadDangerousCommandsFile(filePath)
    const rule = findDangerousCommand(rules, 'rm -rf /')
    assert.ok(rule)
    const message = formatDangerousCommandRejection(rule, filePath)
    assert.match(message, /禁止递归删除/)
    assert.match(message, /rm -rf/)
    assert.match(message, /dangerous-commands\.json/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
