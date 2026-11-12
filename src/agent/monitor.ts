// src/agent/monitor.ts
// 监视器 —— 把「过一会儿再看一眼」变成一次工具调用。
//
// 解决的是这类需求:跑一条要几分钟的命令、到了某个时间点回头看进度、
// 盯一眼远程沙盒还连不连得上。没有它,模型只能自己一轮轮去问。
//
// 两种用法:
//   - 后台:起完立刻返回工具结果,回合照常结束。到点或命令结束时
//     由这里回调出去,调用方负责把状态推回上下文并开新的一轮。
//   - 阻塞:在工具调用内等到结束或到点,直接把状态当工具结果返回。
//
// 工具是纯函数,所以状态不放在工具里:注册表由调用方创建并注入,
// 工具只负责把参数翻译成一次 start。

import type { Logger } from '../core/logger.ts'
import type { BackgroundExec, ExecutionWorld } from '../world/executionWorld.ts'

/** 盯的是什么。 */
export type MonitorKind = 'command' | 'timer' | 'sandbox'

/**
 * 报告进上下文时的标记,让模型分得清这不是用户说的话。
 * 和钩子用的 `[hook]` 是同一个道理。
 */
export const MONITOR_REPORT_MARK = '[monitor]'

/** 同时最多开几个。再多就没人看得过来了。 */
export const MAX_ACTIVE_MONITORS = 8

/** 一个监视器最多报几次。定时一次 + 结束一次,留点余量。 */
const MAX_REPORTS_PER_MONITOR = 3

/** 命令默认最长跑多久。跑飞了要有人收尸。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const MAX_COMMAND_TIMEOUT_MS = 600_000

/** 阻塞模式最多等多久。等太久不如让模型干别的去。 */
export const MAX_BLOCKING_WAIT_MS = 60_000

/** 不给 afterMs 的定时监视器等多久。 */
const DEFAULT_TIMER_AFTER_MS = 1_000

/** 报告里带多少输出尾部。够看清最后几行报错就行。 */
const REPORT_TAIL_CHARS = 2_000

export interface MonitorStartRequest {
  kind: MonitorKind
  /** kind=command 时要跑的命令(交给 shell 执行) */
  command?: string
  /** 多久之后先报一次。不给就只有结束报告(定时器必给) */
  afterMs?: number
  /** 命令最多跑多久,到点就杀 */
  timeoutMs?: number
}

export interface MonitorStartResult {
  id: string
  /** 给模型看的启动回执 */
  text: string
  /**
   * 第一份报告。命令结束或定时到点,先到先得。
   * 阻塞模式 await 它,后台模式直接扔掉。
   */
  firstReport: Promise<string>
}

export interface MonitorRegistry {
  start(request: MonitorStartRequest): Promise<MonitorStartResult>
  /** 还在跑或还在等的数量 */
  activeCount(): number
  /** 取消全部:清定时器、杀掉还在跑的命令。会话结束必须调 */
  cancelAll(): void
}

export interface MonitorRegistryOptions {
  world: ExecutionWorld
  /** 命令在哪个目录跑。通常是工作区根 */
  workspaceRoot: string
  /** 报告交给调用方送进上下文。注册表自己不知道回合是怎么跑的 */
  report: (text: string) => void
  logger?: Logger
}

/** 一次监视的运行时状态。 */
interface ActiveMonitor {
  id: string
  kind: MonitorKind
  startedAt: number
  reportCount: number
  settled: boolean
  timers: NodeJS.Timeout[]
  background?: BackgroundExec
  resolveFirstReport: (text: string) => void
}

export function createMonitorRegistry(options: MonitorRegistryOptions): MonitorRegistry {
  const monitors = new Map<string, ActiveMonitor>()
  let sequence = 0
  let closed = false

  /** 发一份报告。超过次数上限、或会话已经结束,就直接丢掉。 */
  const emit = (monitor: ActiveMonitor, text: string): void => {
    if (closed) return
    if (monitor.reportCount >= MAX_REPORTS_PER_MONITOR) {
      options.logger?.warn(
        { monitorId: monitor.id, kind: monitor.kind, reportCount: monitor.reportCount },
        '监视器报告次数已达上限,后面的报告丢弃',
      )
      return
    }
    monitor.reportCount += 1
    options.report(text)
  }

  /** 结束报告:发一次就不再发,并把监视器摘掉。 */
  const settle = (monitor: ActiveMonitor, text: string): void => {
    if (monitor.settled) return
    monitor.settled = true
    for (const timer of monitor.timers) clearTimeout(timer)
    monitor.timers.length = 0
    monitors.delete(monitor.id)
    monitor.resolveFirstReport(text)
    emit(monitor, text)
  }

  const startCommandMonitor = async (
    monitor: ActiveMonitor,
    request: MonitorStartRequest,
  ): Promise<MonitorStartResult> => {
    const command = request.command?.trim()
    if (!command) throw new Error('kind=command 必须给 command')

    // 远程世界的沙盒协议还没有增量输出,实现不了后台执行。
    // 硬要模拟的话只能把整条命令阻塞跑完,那就不是监视器了。
    if (!options.world.execBackground) {
      throw new Error(
        '当前执行世界不支持后台执行命令(远程沙盒协议还没有增量输出)。'
        + '改用 run_bash,或者用 kind=timer / kind=sandbox 监视状态。',
      )
    }

    const timeoutMs = clamp(
      request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      1_000,
      MAX_COMMAND_TIMEOUT_MS,
    )
    const background = await options.world.execBackground({
      argv: ['bash', '-c', command],
      cwd: options.workspaceRoot,
      timeoutMs,
    })
    monitor.background = background

    // 到点先看一眼,还在跑就报状态;跑完了就不必再单独报一次。
    if (request.afterMs !== undefined) {
      const afterMs = clamp(request.afterMs, 0, MAX_COMMAND_TIMEOUT_MS)
      monitor.timers.push(setTimeout(() => {
        if (monitor.settled || background.status() !== 'running') return
        emit(monitor, formatRunningReport(monitor, background, command))
      }, afterMs))
    }

    // 超时兜底:命令自己不肯退,由这里杀掉,免得一条刷屏命令永远占着。
    monitor.timers.push(setTimeout(() => {
      if (background.status() !== 'running') return
      options.logger?.warn(
        { monitorId: monitor.id, timeoutMs, command },
        '后台命令超过时限,已终止',
      )
      background.kill()
    }, timeoutMs))

    void background.finished().then(() => {
      settle(monitor, formatFinishedReport(monitor, background, command, timeoutMs))
    })

    return {
      id: monitor.id,
      text: `已启动监视器 ${monitor.id}:命令已在后台运行,最长 ${formatSeconds(timeoutMs)}。`
        + `${request.afterMs !== undefined ? `到 ${formatSeconds(request.afterMs)} 时先报一次状态,` : ''}`
        + '命令结束时会把结果推给你。这期间你可以继续做别的事。',
      firstReport: firstReportOf(monitor),
    }
  }

  const startTimerMonitor = (request: MonitorStartRequest): MonitorStartResult => {
    const afterMs = clamp(request.afterMs ?? DEFAULT_TIMER_AFTER_MS, 0, MAX_COMMAND_TIMEOUT_MS)
    const monitor = createMonitor('timer')
    monitor.timers.push(setTimeout(() => {
      settle(monitor, `${MONITOR_REPORT_MARK} ${monitor.id} 定时报告:已过 ${formatSeconds(afterMs)}。`)
    }, afterMs))
    return {
      id: monitor.id,
      text: `已启动监视器 ${monitor.id}:${formatSeconds(afterMs)} 后向你报告。`,
      firstReport: firstReportOf(monitor),
    }
  }

  const startSandboxMonitor = async (request: MonitorStartRequest): Promise<MonitorStartResult> => {
    const afterMs = clamp(request.afterMs ?? DEFAULT_TIMER_AFTER_MS, 0, MAX_COMMAND_TIMEOUT_MS)
    const monitor = createMonitor('sandbox')
    monitor.timers.push(setTimeout(() => {
      void describeSandbox(options).then((text) => {
        settle(monitor, `${MONITOR_REPORT_MARK} ${monitor.id} 沙盒状态:\n${text}`)
      })
    }, afterMs))
    return {
      id: monitor.id,
      text: `已启动监视器 ${monitor.id}:${formatSeconds(afterMs)} 后报告沙盒状态。`,
      firstReport: firstReportOf(monitor),
    }
  }

  const createMonitor = (kind: MonitorKind): ActiveMonitor => {
    sequence += 1
    const monitor: ActiveMonitor = {
      id: `mon_${sequence}`,
      kind,
      startedAt: Date.now(),
      reportCount: 0,
      settled: false,
      timers: [],
      resolveFirstReport: () => {},
    }
    monitors.set(monitor.id, monitor)
    return monitor
  }

  const firstReportOf = (monitor: ActiveMonitor): Promise<string> => {
    return new Promise<string>((resolve) => {
      monitor.resolveFirstReport = resolve
    })
  }

  return {
    async start(request) {
      if (closed) throw new Error('会话已结束,不能再启动监视器')
      if (monitors.size >= MAX_ACTIVE_MONITORS) {
        throw new Error(`同时最多 ${MAX_ACTIVE_MONITORS} 个监视器,先等已有的结束`)
      }

      if (request.kind === 'timer') return startTimerMonitor(request)
      if (request.kind === 'sandbox') return startSandboxMonitor(request)

      // 命令监视器要先建出来再起进程:起进程失败时监视器不该留在表里
      const monitor = createMonitor('command')
      try {
        return await startCommandMonitor(monitor, request)
      } catch (error) {
        monitors.delete(monitor.id)
        throw error
      }
    },

    activeCount: () => monitors.size,

    cancelAll() {
      closed = true
      for (const monitor of monitors.values()) {
        for (const timer of monitor.timers) clearTimeout(timer)
        monitor.timers.length = 0
        monitor.background?.kill()
      }
      if (monitors.size > 0) {
        options.logger?.info({ monitorCount: monitors.size }, '会话结束,已取消全部监视器')
      }
      monitors.clear()
    },
  }
}

/** 还在跑的时候报什么。只报状态和尾部,不猜结论。 */
function formatRunningReport(monitor: ActiveMonitor, background: BackgroundExec, command: string): string {
  const elapsed = formatSeconds(background.elapsedMs())
  const tail = takeTail(background.outputTail())
  const lines = [
    `${MONITOR_REPORT_MARK} ${monitor.id} 仍在运行(已 ${elapsed}):${truncateCommand(command)}`,
  ]
  if (tail) lines.push('输出尾部:', tail)
  return lines.join('\n')
}

/** 结束了报什么。退出码和非零时的尾部最重要。 */
function formatFinishedReport(
  monitor: ActiveMonitor,
  background: BackgroundExec,
  command: string,
  timeoutMs: number,
): string {
  const elapsed = formatSeconds(background.elapsedMs())
  const status = background.status()
  const exitCode = background.exitCode()
  const headline = status === 'killed'
    ? `已被终止(跑满 ${formatSeconds(timeoutMs)} 或会话结束)`
    : status === 'failed'
      ? '启动失败'
      : `已结束(exit ${exitCode ?? '?'})`

  const lines = [
    `${MONITOR_REPORT_MARK} ${monitor.id} ${headline},耗时 ${elapsed}:${truncateCommand(command)}`,
  ]
  const tail = takeTail(background.outputTail())
  if (tail) lines.push('输出尾部:', tail)
  return lines.join('\n')
}

/** 沙盒/连接状态。读一次工作区根目录当连通性探针。 */
async function describeSandbox(options: MonitorRegistryOptions): Promise<string> {
  const { world } = options
  const lines = [
    `沙盒:${world.sandboxId ?? '本地工作区'}`,
    `模式:${world.policy.mode}`,
    `工作区:${world.workspaceRoot}`,
  ]
  try {
    await world.list('.')
    lines.push('连通性:正常')
  } catch (error) {
    // 探针失败本身就是结论,不用抛
    lines.push(`连通性:不可达(${(error as Error).message})`)
  }
  return lines.join('\n')
}

function takeTail(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  return trimmed.length <= REPORT_TAIL_CHARS
    ? trimmed
    : `…(前略)\n${trimmed.slice(trimmed.length - REPORT_TAIL_CHARS)}`
}

function truncateCommand(command: string): string {
  const collapsed = command.replace(/\s+/g, ' ').trim()
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 120)}…`
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  return seconds >= 10 ? `${Math.round(seconds)} 秒` : `${seconds.toFixed(1)} 秒`
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}