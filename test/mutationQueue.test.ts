import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { withFileMutationQueue } from '../src/mutationQueue.ts'

// 文件变更队列的测试。
// 核心性质:同一文件的操作串行,不同文件的操作并行。

function createTempDirectory(): string {
  return path.join(
    os.tmpdir(),
    `grassagent-queue-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
}

test('同一文件的操作依次执行', async () => {
  const order: string[] = []
  const filePath = path.join(createTempDirectory(), 'a.txt')

  await Promise.all([
    withFileMutationQueue(filePath, async () => {
      order.push('开始1')
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('结束1')
    }),
    withFileMutationQueue(filePath, async () => {
      order.push('开始2')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('结束2')
    }),
  ])

  // 第一个必须完整跑完,第二个才开始
  assert.deepEqual(order, ['开始1', '结束1', '开始2', '结束2'])
})

test('不同文件的操作可以并行', async () => {
  const directory = createTempDirectory()
  let active = 0
  let peak = 0

  const operation = async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 40))
    active--
  }

  await Promise.all([
    withFileMutationQueue(path.join(directory, 'a.txt'), operation),
    withFileMutationQueue(path.join(directory, 'b.txt'), operation),
    withFileMutationQueue(path.join(directory, 'c.txt'), operation),
  ])

  assert.ok(peak >= 2, `不同文件应并行,实际峰值 ${peak}`)
})

test('可重入:已持有锁时再调不会死等', async () => {
  const filePath = path.join(createTempDirectory(), 'a.txt')
  let innerRan = false

  // 模拟工具内部又包了一层队列的场景。
  // 没有可重入支持的话,这里会把自己等死,测试会超时。
  await withFileMutationQueue(filePath, async () => {
    await withFileMutationQueue(filePath, async () => {
      innerRan = true
    })
  })

  assert.equal(innerRan, true, '内层操作应当执行')
})

test('可重入:不同 key 的嵌套仍然走队列', async () => {
  const directory = createTempDirectory()
  const order: string[] = []

  await withFileMutationQueue(path.join(directory, 'a.txt'), async () => {
    order.push('a开始')
    // 内层用不同文件,应该正常排队而不是被识别成重入
    await withFileMutationQueue(path.join(directory, 'b.txt'), async () => {
      order.push('b')
    })
    order.push('a结束')
  })

  assert.deepEqual(order, ['a开始', 'b', 'a结束'])
})

test('操作抛错时队列能继续使用', async () => {
  const filePath = path.join(createTempDirectory(), 'a.txt')

  await assert.rejects(
    withFileMutationQueue(filePath, async () => {
      throw new Error('故意失败')
    }),
    /故意失败/,
  )

  // 队列不能因为上一次异常而卡住
  let ran = false
  await withFileMutationQueue(filePath, async () => {
    ran = true
  })
  assert.equal(ran, true)
})

test('文件不存在时也能排队', async () => {
  const filePath = path.join(createTempDirectory(), 'not-created-yet.txt')
  const order: string[] = []

  await Promise.all([
    withFileMutationQueue(filePath, async () => {
      order.push('1')
    }),
    withFileMutationQueue(filePath, async () => {
      order.push('2')
    }),
  ])

  assert.deepEqual(order, ['1', '2'])
})

test('同一文件的不同写法归到同一条队列', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grassagent-realpath-'))
  try {
    const realPath = path.join(directory, 'target.txt')
    await fs.writeFile(realPath, 'x', 'utf-8')

    // 通过软链指向同一个文件
    const linkPath = path.join(directory, 'alias.txt')
    await fs.symlink(realPath, linkPath, 'file')

    const order: string[] = []
    await Promise.all([
      withFileMutationQueue(realPath, async () => {
        order.push('真实路径')
        await new Promise((resolve) => setTimeout(resolve, 30))
        order.push('真实路径结束')
      }),
      withFileMutationQueue(linkPath, async () => {
        order.push('软链')
      }),
    ])

    // 软链和真实路径指向同一个文件,必须串行
    assert.deepEqual(order, ['真实路径', '真实路径结束', '软链'])
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
