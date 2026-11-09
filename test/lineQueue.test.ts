import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineQueue } from '../src/lineQueue.ts'

test('先入队的行按顺序取出', () => {
  const queue = new LineQueue()
  queue.push('第一行')
  queue.push('第二行')
  assert.equal(queue.shift(), '第一行')
  assert.equal(queue.shift(), '第二行')
  assert.equal(queue.shift(), undefined)
})

test('队列里已有行时 take 立刻返回，不阻塞', async () => {
  const queue = new LineQueue()
  queue.push('已在')
  assert.equal(await queue.take(), '已在')
})

test('take 会等到下一行', async () => {
  const queue = new LineQueue()
  const pending = queue.take()
  queue.push('稍后')
  assert.equal(await pending, '稍后')
})

test('关闭时正在等的 take 得到 null，已入队的行还在', async () => {
  const queue = new LineQueue()
  queue.push('留下')
  const pending = queue.take()
  // 上面那次 take 已经把「留下」取走了，再等下一次
  assert.equal(await pending, '留下')
  const waiting = queue.take()
  queue.close()
  assert.equal(await waiting, null)
  queue.push('关闭后')
  assert.equal(queue.shift(), undefined)
})

test('关闭之后仍能取出关闭前入队的行', () => {
  const queue = new LineQueue()
  queue.push('还在')
  queue.close()
  assert.equal(queue.shift(), '还在')
  assert.equal(queue.shift(), undefined)
})

test('已经 abort 的 take 不取走行', async () => {
  const queue = new LineQueue()
  queue.push('留给后面')
  const controller = new AbortController()
  controller.abort()
  assert.equal(await queue.take(controller.signal), null)
  assert.equal(queue.shift(), '留给后面')
})

test('等待中 abort 返回 null，之后到达的行留在队列', async () => {
  const queue = new LineQueue()
  const controller = new AbortController()
  const pending = queue.take(controller.signal)
  controller.abort()
  assert.equal(await pending, null)
  queue.push('取消之后')
  assert.equal(queue.shift(), '取消之后')
})
