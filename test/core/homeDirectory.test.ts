import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  HOME_ENV_NAME,
  defaultHomeDirectory,
  resolveHomeDirectory,
} from '../../src/core/homeDirectory.ts'

const fakeHomedir = path.join(os.tmpdir(), 'grass-home-fixture')
const fakeCwd = path.join(os.tmpdir(), 'grass-cwd-fixture')

test('环境变量名沿用 GRASSAGENT_ 前缀', () => {
  assert.equal(HOME_ENV_NAME, 'GRASSAGENT_HOME')
})

test('没配宿主目录时用 ~/.grassagent', () => {
  const expected = path.join(fakeHomedir, '.grassagent')
  assert.equal(defaultHomeDirectory(fakeHomedir), expected)
  assert.equal(resolveHomeDirectory(undefined, { homedir: fakeHomedir }), expected)
  assert.equal(resolveHomeDirectory('', { homedir: fakeHomedir }), expected)
  assert.equal(resolveHomeDirectory('   ', { homedir: fakeHomedir }), expected)
})

test('显式绝对路径直接采用', () => {
  const target = path.join(os.tmpdir(), 'my-grass-home')
  assert.equal(resolveHomeDirectory(target, { homedir: fakeHomedir }), path.resolve(target))
})

test('~ 前缀按用户 home 展开,反斜杠写法也认', () => {
  const homedir = path.resolve(fakeHomedir)
  assert.equal(resolveHomeDirectory('~', { homedir: fakeHomedir }), homedir)
  assert.equal(resolveHomeDirectory('~/grass', { homedir: fakeHomedir }), path.join(homedir, 'grass'))
  assert.equal(resolveHomeDirectory('~\\grass', { homedir: fakeHomedir }), path.join(homedir, 'grass'))
})

test('相对路径按启动目录解析', () => {
  assert.equal(
    resolveHomeDirectory('./grass-home', { homedir: fakeHomedir, cwd: fakeCwd }),
    path.join(fakeCwd, 'grass-home'),
  )
})

test('值两端空白会被去掉', () => {
  const target = path.join(os.tmpdir(), 'my-grass-home')
  assert.equal(resolveHomeDirectory(`  ${target}  `, { homedir: fakeHomedir }), path.resolve(target))
})
