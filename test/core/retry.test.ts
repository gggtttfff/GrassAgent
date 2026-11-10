import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ApiError,
  NetworkError,
  isRetryableError,
  withRetry,
  createConcurrencyGate,
  parseRetryAfterHeader,
} from '../../src/core/retry.ts'

test('429 和 5xx 被判定为可重试', () => {
  assert.equal(new ApiError('x', { status: 429 }).retryable, true)
  assert.equal(new ApiError('x', { status: 500 }).retryable, true)
  assert.equal(new ApiError('x', { status: 503 }).retryable, true)
  assert.equal(new ApiError('x', { status: 408 }).retryable, true)
})

test('4xx 业务错误被判定为不可重试', () => {
  assert.equal(new ApiError('x', { status: 400 }).retryable, false)
  assert.equal(new ApiError('x', { status: 401 }).retryable, false)
  assert.equal(new ApiError('x', { status: 404 }).retryable, false)
})

test('isRetryableError 识别网络错误', () => {
  assert.equal(isRetryableError(new NetworkError('boom')), true)
  assert.equal(isRetryableError(new ApiError('x', { status: 500 })), true)
  assert.equal(isRetryableError(new ApiError('x', { status: 400 })), false)
  assert.equal(isRetryableError(new Error('普通错误')), false)
})

test('isRetryableError 识别 Node 系统网络错误码', () => {
  const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
  assert.equal(isRetryableError(error), true)
  const notFound = Object.assign(new Error('dns'), { code: 'ENOTFOUND' })
  assert.equal(isRetryableError(notFound), true)
})

test('可重试错误会重试到成功', async () => {
  let attempts = 0
  const result = await withRetry(
    async () => {
      attempts++
      if (attempts < 3) throw new NetworkError('暂时失败')
      return '成功'
    },
    { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5 },
  )
  assert.equal(result, '成功')
  assert.equal(attempts, 3)
})

test('不可重试错误立即失败,不消耗重试预算', async () => {
  let attempts = 0
  await assert.rejects(
    withRetry(
      async () => {
        attempts++
        throw new ApiError('参数错误', { status: 400 })
      },
      { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5 },
    ),
  )
  assert.equal(attempts, 1, '不可重试的错误只应尝试一次')
})

test('重试次数耗尽后抛出最后一次错误', async () => {
  let attempts = 0
  await assert.rejects(
    withRetry(
      async () => {
        attempts++
        throw new NetworkError('一直失败')
      },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    ),
    NetworkError,
  )
  assert.equal(attempts, 3, '首次 + 2 次重试')
})

test('abort 信号会中断重试', async () => {
  const controller = new AbortController()
  let attempts = 0
  await assert.rejects(
    withRetry(
      async () => {
        attempts++
        controller.abort()
        throw new NetworkError('失败')
      },
      { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 5, signal: controller.signal },
    ),
  )
  assert.ok(attempts <= 2, `aborted 后不应继续重试,实际尝试 ${attempts} 次`)
})

test('并发闸门限制同时在飞的任务数', async () => {
  const gate = createConcurrencyGate(2)
  let active = 0
  let peak = 0

  const task = async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active--
  }

  await Promise.all(Array.from({ length: 8 }, () => gate(task)))
  assert.ok(peak <= 2, `并发峰值应不超过 2,实际 ${peak}`)
})

test('并发上限非法时抛错', () => {
  assert.throws(() => createConcurrencyGate(0), /并发上限/)
})

test('Retry-After 秒数被正确解析', () => {
  assert.equal(parseRetryAfterHeader('30'), 30_000)
  assert.equal(parseRetryAfterHeader('0'), 0)
  assert.equal(parseRetryAfterHeader(' 5 '), 5_000)
})

test('Retry-After 为空或非法时返回 undefined', () => {
  assert.equal(parseRetryAfterHeader(null), undefined)
  assert.equal(parseRetryAfterHeader(''), undefined)
  assert.equal(parseRetryAfterHeader('garbage'), undefined)
})

test('Retry-After 为 HTTP 日期时返回剩余毫秒', () => {
  const future = new Date(Date.now() + 10_000).toUTCString()
  const parsed = parseRetryAfterHeader(future)
  assert.ok(parsed !== undefined)
  assert.ok(parsed > 8_000 && parsed <= 10_000, `实际 ${parsed}`)
})

test('Retry-After 为过去时间时返回 0', () => {
  const past = new Date(Date.now() - 10_000).toUTCString()
  assert.equal(parseRetryAfterHeader(past), 0)
})
