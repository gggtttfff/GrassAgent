// src/ui/lineQueue.ts
// 行队列 —— 非交互模式下，回合进行中到达的输入先排在这里。
//
// 编辑器在回合中会关掉提交。管道里的下一行如果这时送进编辑器，
// 回车会被丢掉，字符却留在输入框里，ask_user 再也读不到这行回答。
// 所以忙的时候整行先入队：提问来取，回合结束再把剩下的行当成下一次输入。

export class LineQueue {
  private pending: string[] = []
  private waiter: ((line: string | null) => void) | null = null
  private closed = false

  /** 入队。有人正在等的话直接交给它，不进数组。 */
  push(line: string): void {
    if (this.closed) return
    const waiting = this.waiter
    if (waiting) {
      this.waiter = null
      waiting(line)
      return
    }
    this.pending.push(line)
  }

  /**
   * 取出已在队列里的下一行。
   * 没有就返回 undefined，不阻塞——回合结束时用它决定要不要开始下一轮。
   */
  shift(): string | undefined {
    return this.pending.shift()
  }

  /**
   * 取下一行。队列空着就等到有行、关闭或 abort。
   *
   * abort 时返回 null，并且卸掉等待者。之后才到达的行留在队列里，
   * 不会被这次已经取消的等待吞掉。
   * 关闭且没有剩余行时也返回 null。
   */
  take(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null)
    const next = this.pending.shift()
    if (next !== undefined) return Promise.resolve(next)
    if (this.closed) return Promise.resolve(null)

    return new Promise((resolve) => {
      let settled = false
      const finish = (line: string | null): void => {
        if (settled) return
        settled = true
        if (this.waiter === finish) this.waiter = null
        signal?.removeEventListener('abort', onAbort)
        resolve(line)
      }
      const onAbort = (): void => finish(null)
      this.waiter = finish
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) finish(null)
      }
    })
  }

  /** 输入结束。正在等的人立刻收到 null，已经入队的行还在。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    const waiting = this.waiter
    this.waiter = null
    waiting?.(null)
  }
}
