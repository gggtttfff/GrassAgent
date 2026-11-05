// src/transport.ts
// 传输层 —— 负责 HTTP 请求的可靠性:超时、重试、并发控制、错误分类。
// 单独成层的原因:重试只对"还没拿到响应体"的情况安全,
// 而 SSE 流一旦开始读 body 就不该重试(会重复内容),这个边界必须守住。

import { ApiError, NetworkError, withRetry, createConcurrencyGate, parseRetryAfterHeader } from './retry.ts'
import type { Logger } from './logger.ts'

export interface TransportOptions {
  timeoutMs: number
  maxRetries: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  maxConcurrency: number
  logger?: Logger
}

export interface Transport {
  // 发请求。失败时抛 ApiError / NetworkError,由调用方决定如何呈现。
  request(
    url: string,
    init: RequestInit,
    options: { signal?: AbortSignal; operationName: string },
  ): Promise<Response>
}

// 服务端要求等待的最长时间上限,防止 Retry-After 给出离谱的值把进程挂住
const MAX_RETRY_AFTER_MS = 60_000

// 合并多个信号:任一触发则整体 abort
function combineSignals(signals: (AbortSignal | undefined)[]): { signal?: AbortSignal; dispose: () => void } {
  const present = signals.filter((item): item is AbortSignal => Boolean(item))
  if (present.length === 0) return { signal: undefined, dispose: () => {} }
  if (present.length === 1) return { signal: present[0], dispose: () => {} }

  const controller = new AbortController()
  const onAbort = (event: Event) => {
    controller.abort((event.target as AbortSignal).reason)
  }
  for (const item of present) {
    if (item.aborted) {
      controller.abort(item.reason)
      break
    }
    item.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const item of present) item.removeEventListener('abort', onAbort)
    },
  }
}

// 等一段时间,用于遵守服务端的 Retry-After 指示
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// 创建传输层。并发闸门在实例上持有,保证同一实例内的请求共享上限。
export function createTransport(options: TransportOptions): Transport {
  const concurrencyGate = createConcurrencyGate(options.maxConcurrency)

  const request: Transport['request'] = async (url, init, requestOptions) => {
    // 并发闸门:超过上限的请求排队等待
    return concurrencyGate(async () => {
      return withRetry(
        async () => {
          // 每次尝试都要新的超时控制器。
          // 如果超时控制器建在重试之外,第一次超时后信号会一直是 aborted 状态,
          // 后续重试会立刻失败,退避重试就形同虚设。
          const timeoutController = new AbortController()
          const timeoutTimer = setTimeout(() => {
            timeoutController.abort(new Error(`请求超时,超过 ${options.timeoutMs}ms`))
          }, options.timeoutMs)

          const { signal, dispose } = combineSignals([
            requestOptions.signal,
            timeoutController.signal,
          ])

          try {
            let response: Response
            try {
              response = await fetch(url, { ...init, signal })
            } catch (error) {
              // 用户主动中断不算网络故障,交给上层按 aborted 处理
              if (requestOptions.signal?.aborted) {
                throw error
              }
              throw new NetworkError(`请求失败: ${(error as Error).message}`, { cause: error })
            }

            if (!response.ok) {
              // 错误响应要读完 body 才能拿到服务端给的原因
              const body = await response.text().catch(() => '')
              const error = new ApiError(`API ${response.status}: ${body.slice(0, 500)}`, {
                status: response.status,
                body,
              })

              // 429 时服务端会给出 Retry-After,先按它等待再退避重试,
              // 否则退避时间短于服务端要求的时间,重试仍会被拒。
              const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'))
              if (retryAfterMs !== undefined && error.retryable) {
                const waitMs = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
                options.logger?.warn({
                  operation: requestOptions.operationName,
                  status: response.status,
                  waitMs,
                }, '命中限流,按 Retry-After 等待')
                await delay(waitMs)
              }

              throw error
            }

            return response
          } finally {
            clearTimeout(timeoutTimer)
            dispose()
          }
        },
        {
          maxRetries: options.maxRetries,
          baseDelayMs: options.retryBaseDelayMs,
          maxDelayMs: options.retryMaxDelayMs,
          signal: requestOptions.signal,
          logger: options.logger,
          operationName: requestOptions.operationName,
        },
      )
    })
  }

  return { request }
}
