// src/retry.ts
// 可靠性层 —— 可重试错误分类、指数退避重试、并发闸门。
// 原则:只对"重试有意义"的错误退避(网络抖动、429、5xx),
// 对 4xx 业务错误(401/404/参数错)立即失败,避免无意义等待。

import pRetry, { AbortError, type RetryContext } from 'p-retry'
import limit, { type LimitFunction } from 'p-limit'
import type { Logger } from './logger.ts'

// HTTP 状态码 -> 是否值得重试
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504])

// 携带 HTTP 上下文的错误。llm.ts 用它把状态码和响应体带出来。
export class ApiError extends Error {
  readonly status: number
  readonly body: string
  readonly retryable: boolean

  constructor(message: string, options: { status: number; body?: string; retryable?: boolean }) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status
    this.body = options.body ?? ''
    this.retryable = options.retryable ?? RETRYABLE_STATUS_CODES.has(options.status)
  }
}

// 网络层错误(连接被拒、DNS 失败、超时)统一包装成这个
export class NetworkError extends Error {
  readonly retryable = true

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'NetworkError'
  }
}

// 判断一个错误是否值得重试
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable
  if (error instanceof NetworkError) return true
  // AbortError 表示用户主动中断,不该重试
  if (error instanceof AbortError) return false
  // Node 的系统级网络错误码
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code)) {
    return true
  }
  return false
}

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  signal?: AbortSignal
  logger?: Logger
  // 每次尝试的上下文标记,用于日志里区分是哪个调用在重试
  operationName?: string
}

// 指数退避重试。
// randomize 打散延迟,避免多个客户端同时重试撞在一起形成尖峰。
export async function withRetry<Result>(
  operation: (attemptNumber: number) => Promise<Result>,
  options: RetryOptions,
): Promise<Result> {
  const operationName = options.operationName ?? 'operation'

  return pRetry(operation, {
    retries: options.maxRetries,
    factor: 2,
    minTimeout: options.baseDelayMs,
    maxTimeout: options.maxDelayMs,
    randomize: true,
    signal: options.signal,
    // 不可重试的错误直接终止,不消耗退避预算
    shouldRetry: (context: RetryContext) => {
      const retryable = isRetryableError(context.error)
      if (!retryable) {
        options.logger?.debug({
          operation: operationName,
          attempt: context.attemptNumber,
          errorMessage: (context.error as Error).message,
        }, '错误不可重试,停止重试')
      }
      return retryable
    },
    onFailedAttempt: (context: RetryContext) => {
      const error = context.error as Error
      options.logger?.warn({
        operation: operationName,
        attempt: context.attemptNumber,
        retriesLeft: context.retriesLeft,
        delayMs: context.retryDelay,
        errorMessage: error.message,
        status: error instanceof ApiError ? error.status : undefined,
      }, '请求失败,准备重试')
    },
  })
}

// 并发闸门:限制同时在飞的请求数量。
export function createConcurrencyGate(maxConcurrency: number): LimitFunction {
  if (maxConcurrency < 1) {
    throw new Error(`并发上限必须大于 0,当前为 ${maxConcurrency}`)
  }
  return limit(maxConcurrency)
}

// 429 限流时,服务端可能通过 Retry-After 头告知等待秒数。
// 解析它,让退避时长对齐服务端的预期,而不是盲目按指数退避。
export function parseRetryAfterHeader(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const trimmed = headerValue.trim()
  // Retry-After 可以是秒数,也可以是 HTTP 日期
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }
  const targetDate = Date.parse(trimmed)
  if (Number.isNaN(targetDate)) return undefined
  const delta = targetDate - Date.now()
  return delta > 0 ? delta : 0
}
