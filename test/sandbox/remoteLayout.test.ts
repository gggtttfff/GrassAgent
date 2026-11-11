import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSourceHash,
  formatNodeVersion,
  homeWorkspace,
  MINIMUM_NODE_VERSION,
  nodeVersionIsSupported,
  parseNodeVersion,
  sandboxDirectory,
  sourceDirectory,
  stagingDirectory,
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