import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createMonitorRegistry, MONITOR_REPORT_MARK } from '../../src/agent/monitor.ts'
import { builtinTools } from '../../src/agent/tools.ts'
import { createLocalWorld } from '../../src/world/localWorld.ts'
import type { ExecutionWorld } from '../../src/world/executionWorld.ts'

// 监视器的测试。
//
// 核心不变量:报告只发一次结束报告、取消之后不再发任何东西、
// 远程世界没有后台执行能力时要明确报错而不是假装能用。

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'grass-monitor-'))
  try {
    await run(workspace)
  } finally {
    // Windows 上后台命令刚被杀掉时,目录可能还被锁一小会儿
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(workspace, { recursive: true, force: true })
        return
      } catch {
        await delay(100)
      }
    }
  }
}

/** 等一小会儿,让定时器有机会跑 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('命令监视器在结束时报告退出码和输出尾部', async () => {
  await withWorkspace(async (workspace) => {
    const world = await createLocalWorld({ workspace })
    const reports: string[] = []
    const registry = createMonitorRegistry({
      world,
      workspaceRoot: world.workspaceRoot,
      report: (text) => reports.push(text),
    })

    try {
      const started = await registry.start({ kind: 'command', command: 'echo hello-monitor' })
      const report = await started.firstReport

      assert.match(report, /已结束/)
      assert.match(report, /exit 0/)
      assert.match(report, /hello-monitor/)
      assert.equal(reports.length, 1, '结束报告只发一次')
    } finally {
      registry.cancelAll()
      await world.close()
    }
  })
})

test('命令监视器到点先报一次运行中,结束时再报一次', async () => {
  await withWorkspace(async (workspace) => {
    const world = await createLocalWorld({ workspace })
    const reports: string[] = []
    const registry = createMonitorRegistry({
      world,
      workspaceRoot: world.workspaceRoot,
      report: (text) => reports.push(text),
    })

    try {
      // 跑一个明显超过定时点的命令。写成文件而不是 node -e:
      // Windows 上 bash -c 会翻译成 cmd,括号和引号在里面很容易被切开。
      await writeFile(path.join(workspace, 'slow.mjs'), 'setTimeout(() => {}, 800)\n', 'utf8')
      const started = await registry.start({
        kind: 'command',
        command: 'node slow.mjs',
        afterMs: 100,
        timeoutMs: 5_000,
      })
      const first = await started.firstReport
      assert.ok(first.startsWith(MONITOR_REPORT_MARK), `报告要带标记,实际: ${first}`)
      assert.match(first, /仍在运行/)

      // 命令自然结束后还会再来一份
      await delay(1_200)
      assert.ok(reports.some((report) => /已结束/.test(report)), `应该收到结束报告,实际: ${reports.join('|')}`)
    } finally {
      registry.cancelAll()
      await world.close()
    }
  })
})

test('定时监视器到点报告一次', async () => {
  const world = await createLocalWorld({ workspace: process.cwd() })
  const reports: string[] = []
  const registry = createMonitorRegistry({
    world,
    workspaceRoot: world.workspaceRoot,
    report: (text) => reports.push(text),
  })
  try {
    const started = await registry.start({ kind: 'timer', afterMs: 20 })
    const report = await started.firstReport
    assert.match(report, /定时报告/)
    assert.equal(reports.length, 1)
  } finally {
    registry.cancelAll()
    await world.close()
  }
})

test('沙盒监视器报告模式和工作区,连通性正常', async () => {
  await withWorkspace(async (workspace) => {
    const world = await createLocalWorld({ workspace })
    const registry = createMonitorRegistry({
      world,
      workspaceRoot: world.workspaceRoot,
      report: () => {},
    })
    try {
      const started = await registry.start({ kind: 'sandbox', afterMs: 10 })
      const report = await started.firstReport
      assert.match(report, /沙盒:/)
      assert.match(report, /模式:workspace-write/)
      assert.match(report, /连通性:正常/)
    } finally {
      registry.cancelAll()
      await world.close()
    }
  })
})

test('cancelAll 之后不再产生任何报告', async () => {
  const world = await createLocalWorld({ workspace: process.cwd() })
  const reports: string[] = []
  const registry = createMonitorRegistry({
    world,
    workspaceRoot: world.workspaceRoot,
    report: (text) => reports.push(text),
  })
  try {
    await registry.start({ kind: 'timer', afterMs: 50 })
    registry.cancelAll()
    await delay(120)
    assert.deepEqual(reports, [], '取消之后不该还有报告')
    assert.equal(registry.activeCount(), 0)
  } finally {
    await world.close()
  }
})

test('远程世界没有后台执行能力时给明确错误', async () => {
  // 只实现接口里用得到的部分:这个用例要验的正是「没有 execBackground」
  const world: ExecutionWorld = {
    sandboxId: 'remote-1',
    workspaceRoot: '/workspace',
    policy: { mode: 'workspace-write', workspaceRoot: '/workspace' },
    read: async () => '',
    readRaw: async () => '',
    list: async () => [],
    write: async () => '/workspace/a',
    edit: async () => '/workspace/a',
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', aborted: false, timedOut: false }),
    setMode: async () => {},
    close: async () => {},
  }
  const registry = createMonitorRegistry({ world, workspaceRoot: '/workspace', report: () => {} })

  await assert.rejects(
    () => registry.start({ kind: 'command', command: 'npm test' }),
    /不支持后台执行/,
  )
  // 失败之后不该留下一个占着名额的监视器
  assert.equal(registry.activeCount(), 0)
})

test('monitor 工具默认后台,给模型的是启动回执', async () => {
  await withWorkspace(async (workspace) => {
    const world = await createLocalWorld({ workspace })
    const registry = createMonitorRegistry({
      world,
      workspaceRoot: world.workspaceRoot,
      report: () => {},
    })
    try {
      const tools = await builtinTools({ world, monitors: registry })
      const monitorTool = tools.find((tool) => tool.name === 'monitor')
      assert.ok(monitorTool, '有注册表时应该注册 monitor 工具')

      const result = await monitorTool.execute({ kind: 'command', command: 'echo ok' })
      assert.match(result, /已启动监视器 mon_/)
      assert.match(result, /推给你/)
    } finally {
      registry.cancelAll()
      await world.close()
    }
  })
})

test('monitor 工具 wait=true 时把报告当工具结果返回', async () => {
  await withWorkspace(async (workspace) => {
    const world = await createLocalWorld({ workspace })
    const registry = createMonitorRegistry({
      world,
      workspaceRoot: world.workspaceRoot,
      report: () => {},
    })
    try {
      const tools = await builtinTools({ world, monitors: registry })
      const monitorTool = tools.find((tool) => tool.name === 'monitor')
      assert.ok(monitorTool)

      const result = await monitorTool.execute({ kind: 'command', command: 'echo waited', wait: true })
      assert.match(result, /已结束/)
      assert.match(result, /waited/)
    } finally {
      registry.cancelAll()
      await world.close()
    }
  })
})

test('monitor 工具对后台命令同样套危险命令规则', async () => {
  await withWorkspace(async (workspace) => {
    const world = await createLocalWorld({ workspace })
    const registry = createMonitorRegistry({
      world,
      workspaceRoot: world.workspaceRoot,
      report: () => {},
    })
    try {
      const tools = await builtinTools({
        world,
        monitors: registry,
        dangerousCommands: [{ pattern: 'rm\\s+-rf', reason: '不许递归删', matcher: /rm\s+-rf/ }],
        dangerousCommandsPath: '.grass/dangerous-commands.json',
      })
      const monitorTool = tools.find((tool) => tool.name === 'monitor')
      assert.ok(monitorTool)

      const result = await monitorTool.execute({ kind: 'command', command: 'rm -rf /tmp/x' })
      assert.match(result, /命令被规则拒绝/)
      assert.equal(registry.activeCount(), 0, '被规则拒绝的命令不该起监视器')
    } finally {
      registry.cancelAll()
      await world.close()
    }
  })
})

test('monitor 工具要求 kind=command 时给命令', async () => {
  const world = await createLocalWorld({ workspace: process.cwd() })
  const registry = createMonitorRegistry({
    world,
    workspaceRoot: world.workspaceRoot,
    report: () => {},
  })
  try {
    const tools = await builtinTools({ world, monitors: registry })
    const monitorTool = tools.find((tool) => tool.name === 'monitor')
    assert.ok(monitorTool)
    const result = await monitorTool.execute({ kind: 'command' })
    assert.match(result, /必须给 command/)
  } finally {
    registry.cancelAll()
    await world.close()
  }
})

test('没有注册表时不注册 monitor 工具', async () => {
  const world = await createLocalWorld({ workspace: process.cwd() })
  try {
    const tools = await builtinTools({ world })
    assert.equal(tools.find((tool) => tool.name === 'monitor'), undefined)
  } finally {
    await world.close()
  }
})