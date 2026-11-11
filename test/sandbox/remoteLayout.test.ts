import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSourceHash,
  formatNodeVersion,
  homeWorkspace,
  MINIMUM_NODE_VERSION,
  nodeVersionIsSupported,
  parseNodeVersion,
  parseSandboxState,
  parseSweepListing,
  sandboxDirectory,
  shouldRemoveOrphan,
  sourceDirectory,
  stagingDirectory,
  sweepListingCommand,
} from '../../src/sandbox/remoteLayout.ts'

// 远程目录布局的纯函数测试。
//
// 这些函数决定了「哪些目录能删、哪些不能删」和「什时候要重传源码」,
// 弄错会让同机其他会话的 sandbox 突然找不到源码,或者每都重传一遍。

test('共享源码目录和沙盒目录前缀不同,名字里都能看出用途', () => {
  assert.equal(sourceDirectory('/tmp', 'abc123'), '/tmp/grass-daemon-abc123')
  assert.equal(sandboxDirectory('/tmp', 'sb1'), '/tmp/grass-sandbox-sb1')
  // 根目录带尾斜杠不能拼出双斜杠
  assert.equal(sourceDirectory('/var/lib/grass/', 'abc'), '/var/lib/grass/grass-daemon-abc')
  assert.equal(sandboxDirectory('/var/lib/grass/', 'sb1'), '/var/lib/grass/grass-sandbox-sb1')
})

test('临时目录挂在目标目录旁边,扫描时认得出来', () => {
  const staging = stagingDirectory('/tmp/grass-daemon-abc', 'nonce1')
  assert.ok(staging.startsWith('/tmp/grass-daemon-abc.tmp-'))
  assert.ok(staging.endsWith('nonce1'))
})

test('源码 hash 只看内容和路径,和插入顺序无关', () => {
  const forward = new Map([
    ['a.ts', 'content-a'],
    ['b.ts', 'content-b'],
  ])
  const backward = new Map([
    ['b.ts', 'content-b'],
    ['a.ts', 'content-a'],
  ])
  assert.equal(computeSourceHash(forward).fullHash, computeSourceHash(backward).fullHash)
  // short 是 full 的前 16 位,目录名用短的
  const result = computeSourceHash(forward)
  assert.equal(result.shortHash, result.fullHash.slice(0, 16))
  assert.match(result.fullHash, /^[0-9a-f]{64}$/)
})

test('改内容或改路径都会让 hash 变', () => {
  const base = computeSourceHash(new Map([['a.ts', 'one']]))
  const changedContent = computeSourceHash(new Map([['a.ts', 'two']]))
  const changedPath = computeSourceHash(new Map([['b.ts', 'one']]))
  assert.notEqual(base.fullHash, changedContent.fullHash)
  assert.notEqual(base.fullHash, changedPath.fullHash)
})

test('解析 node --version 的输出', () => {
  assert.deepEqual(parseNodeVersion('v24.22.2\n'), { major: 24, minor: 22, patch: 2 })
  assert.deepEqual(parseNodeVersion('v24.3.0'), { major: 24, minor: 3, patch: 0 })
  // 解析不了要返回 null,不能当成 0 放过
  assert.equal(parseNodeVersion('command not found'), null)
  assert.equal(parseNodeVersion(''), null)
})

test('Node 门槛卡在 24.3,不是 24', () => {
  // type stripping 是 24.3 才默认开启的
  assert.equal(MINIMUM_NODE_VERSION.major, 24)
  assert.equal(MINIMUM_NODE_VERSION.minor, 3)
  assert.equal(nodeVersionIsSupported({ major: 24, minor: 2, patch: 0 }), false)
  assert.equal(nodeVersionIsSupported({ major: 24, minor: 3, patch: 0 }), true)
  assert.equal(nodeVersionIsSupported({ major: 24, minor: 22, patch: 2 }), true)
  assert.equal(nodeVersionIsSupported({ major: 22, minor: 99, patch: 0 }), false)
  assert.equal(nodeVersionIsSupported({ major: 26, minor: 0, patch: 0 }), true)
})

test('版本号格式化回 v 前缀', () => {
  assert.equal(formatNodeVersion({ major: 24, minor: 3, patch: 0 }), 'v24.3.0')
})

test('默认工作区放在用户的 HOME 下', () => {
  // 不用 /workspace(要 root)、也不用 /tmp(tmpfiles 会清),
  assert.equal(homeWorkspace('/root'), '/root/grass-workspace')
  assert.equal(homeWorkspace('/home/dev/'), '/home/dev/grass-workspace')
})

// ---- 残留目录清理 ----
//
// 这些判断错一次的代价是删掉别的会话正在用的沙盒,所以每条放行条件都单独测。

const POLICY = { minimumAgeMs: 30 * 60_000, keepRetentionMs: 7 * 24 * 60 * 60_000 }

function candidate(overrides: Partial<Parameters<typeof shouldRemoveOrphan>[0]> = {}) {
  return {
    directory: '/tmp/grass-sandbox-x',
    ageMs: 60 * 60_000,
    stateReadable: true,
    keep: false,
    keptAgeMs: undefined,
    pidAlive: false,
    ...overrides,
  }
}

test('确实没人要的旧目录才删', () => {
  assert.equal(shouldRemoveOrphan(candidate(), POLICY), true)
})

test('读不到 state.json 的目录绝不自动删', () => {
  // 分不清是谁的,删了可能砸掉别人的会话
  assert.equal(shouldRemoveOrphan(candidate({ stateReadable: false }), POLICY), false)
})

test('进程还活着的目录不删', () => {
  assert.equal(shouldRemoveOrphan(candidate({ pidAlive: true }), POLICY), false)
})

test('太新的目录不删,可能在别的进程部署中', () => {
  assert.equal(shouldRemoveOrphan(candidate({ ageMs: 60_000 }), POLICY), false)
})

test('keep 的目录在保留期内不删,过期才删', () => {
  assert.equal(
    shouldRemoveOrphan(candidate({ keep: true, keptAgeMs: 24 * 60 * 60_000 }), POLICY),
    false,
  )
  assert.equal(
    shouldRemoveOrphan(candidate({ keep: true, keptAgeMs: 30 * 24 * 60 * 60_000 }), POLICY),
    true,
  )
})

test('解析扫描输出:沙盒行和上传残留行', () => {
  const state = JSON.stringify({
    schema: 1,
    sandboxId: 'abc',
    workspace: '/root/grass-workspace',
    sourceHash: 'deadbeef',
    sourceDirectory: '/tmp/grass-daemon-deadbeef',
    port: 40000,
    pid: 1234,
    diskMb: 1024,
    protocolVersion: 2,
    keep: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  const output = [
    ['S', '/tmp/grass-sandbox-abc', '1767225600', '1234', state].join('\t'),
    ['T', '/tmp/grass-daemon-deadbeef.tmp-1-aa', '1767225600'].join('\t'),
    // 坏行要跳过,不能让整次扫描失败
    'garbage',
    '',
  ].join('\n')

  const lines = parseSweepListing(output)
  assert.equal(lines.length, 2)
  const sandbox = lines[0]!
  assert.equal(sandbox.kind, 'sandbox')
  if (sandbox.kind !== 'sandbox') return
  assert.equal(sandbox.directory, '/tmp/grass-sandbox-abc')
  assert.equal(sandbox.pid, 1234)
  assert.equal(sandbox.state?.keep, true)
  assert.equal(sandbox.state?.port, 40000)
  assert.equal(lines[1]!.kind, 'staging')
})

test('state.json 结构不对时当作没有', () => {
  assert.equal(parseSandboxState('not json'), null)
  assert.equal(parseSandboxState('{"schema":2}'), null)
  // 缺必需字段
  assert.equal(parseSandboxState('{"schema":1,"sandboxId":"a"}'), null)
})

test('扫描命令带远程根目录,不写死 /tmp', () => {
  const command = sweepListingCommand('/var/lib/grass')
  assert.ok(command.includes('/var/lib/grass/grass-sandbox-*'))
  assert.ok(command.includes('/var/lib/grass/grass-daemon-*.tmp-*'))
})