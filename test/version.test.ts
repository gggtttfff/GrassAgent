import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVersion } from '../src/version.ts'

// 版本号的测试。
//
// 版本只有 package.json 一个来源,测试就是确认这条线没断。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('readVersion 读出的和 package.json 一致', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'),
  ) as { version: string }
  assert.equal(readVersion(), packageJson.version)
})

test('版本号是三段数字', () => {
  // 发版脚本和 tag 都按这个格式来,格式不对会连锁出问题
  assert.match(readVersion(), /^\d+\.\d+\.\d+/)
})