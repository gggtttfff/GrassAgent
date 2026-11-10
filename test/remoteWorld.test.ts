import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { validateConfig } from '../src/config.ts'
import { builtinTools } from '../src/tools.ts'
import { createInProcessBackend } from '../src/sandbox/inProcessBackend.ts'
import { createControlPlane, type TimerFn } from '../src/sandbox/control.ts'
import { listenControl } from '../src/sandbox/controlHttp.ts'
import { openExecutionWorld, sandboxCreateBody } from '../src/sandbox/openWorld.ts'
import { createDockerBackend, containerEnvLines, dockerRunArguments } from '../src/sandbox/dockerBackend.ts'
import { writeSecretFile } from '../src/sandbox/secrets.ts'
import { SANDBOX_PROTOCOL_VERSION } from '../src/sandbox/protocol.ts'

const idleTimer: TimerFn = () => ({ refresh() {}, cancel() {} })

test('远程世界能列目录,raw 读拿到全文', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grass-remote-list-'))
  try {
    const backend = createInProcessBackend({ stateDir })
    const plane = createControlPlane({ backend, timer: idleTimer })
    const listening = await listenControl(plane)
    try {
      const config = validateConfig({
        ApiKey: 'sk-test',
        ExecutionWorld: 'remote',
        SandboxControlUrl: listening.url,
        SandboxImage: 'test-image',
        Workspace: stateDir,
      })
      const world = await openExecutionWorld(config, { sessionId: 'session-list' })
      // 超过 200 行普通读只给尾部,raw 读要全文
      const manyLines = Array.from({ length: 300 }, (_, index) => `line-${index}`).join('\n')
      await world.write('skill.md', manyLines)
      await world.write('note.txt', 'hello')

      assert.ok((await world.read('skill.md')).length < manyLines.length)
      assert.equal(await world.readRaw('skill.md'), manyLines)

      const entries = await world.list('.')
      const names = entries.map((entry) => entry.name)
      assert.equal(names.includes('note.txt'), true)
      assert.equal(names.includes('skill.md'), true)
      assert.equal(entries.find((entry) => entry.name === 'note.txt')?.size, 5)

      // 越界的路径仍然要被挡住
      await assert.rejects(() => world.list('../etc'), /越界/)
    } finally {
      await listening.close().catch(() => undefined)
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('断开控制面后工具结果是沙盒不可用,不会改读本机文件', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grass-remote-'))
  const decoy = path.join(stateDir, 'decoy')
  await mkdir(decoy)
  await writeFile(path.join(decoy, 'note.txt'), 'local-bytes')
  const backend = createInProcessBackend({ stateDir })
  const plane = createControlPlane({ backend, timer: idleTimer })
  const listening = await listenControl(plane)
  try {
    const config = validateConfig({
      ApiKey: 'sk-test-should-not-leak',
      ExecutionWorld: 'remote',
      SandboxControlUrl: listening.url,
      SandboxImage: 'test-image',
      Workspace: decoy,
    })
    const body = JSON.stringify(sandboxCreateBody(config, 'session-1'))
    assert.equal(body.includes('sk-test-should-not-leak'), false)
    const world = await openExecutionWorld(config, { sessionId: 'session-1' })
    assert.ok(world.sandboxId)
    assert.equal(await world.write('note.txt', 'remote-bytes'), '/workspace/note.txt')
    assert.equal(await world.read('note.txt'), 'remote-bytes')
    await assert.rejects(() => world.read('../etc/passwd'), /越界/)
    await listening.close()
    const readFileTool = (await builtinTools({ world })).find((tool) => tool.name === 'read_file')
    assert.ok(readFileTool)
    const result = await readFileTool.execute({ path: 'note.txt' })
    assert.equal(result, 'error: sandbox unavailable')
    assert.equal(await readFile(path.join(decoy, 'note.txt'), 'utf-8'), 'local-bytes')
  } finally {
    await listening.close().catch(() => undefined)
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('协议版本不符时拆掉半成品,凭据引用缺失时不会创建沙盒', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grass-version-'))
  try {
    const mismatch = createControlPlane({
      backend: createInProcessBackend({ stateDir, daemonVersion: 999 }),
      timer: idleTimer,
    })
    await assert.rejects(
      () => mismatch.create({
        image: 'test-image',
        ttlMs: 60_000,
        cpu: 1,
        memoryMb: 128,
        diskMb: 10,
      }),
      /版本不符/,
    )
    assert.deepEqual(await readdirOrEmpty(stateDir), [])

    let provisioned = 0
    const blocked = createControlPlane({
      backend: {
        async provision() {
          provisioned += 1
          throw new Error('不应该创建')
        },
        async attach() {
          return null
        },
      },
      timer: idleTimer,
    })
    await assert.rejects(
      () => blocked.create({
        image: 'test-image',
        credentialRef: 'missing',
        ttlMs: 60_000,
        cpu: 1,
        memoryMb: 128,
        diskMb: 10,
      }),
      /credentialRef/,
    )
    assert.equal(provisioned, 0)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('控制面配了调用方令牌后,创建和挂回都要校验它', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grass-auth-'))
  const plane = createControlPlane({
    backend: createInProcessBackend({ stateDir }),
    timer: idleTimer,
    controlToken: 'caller-token-123456',
  })
  try {

    // 令牌不对就创建不了
    await assert.rejects(
      () => plane.create({
        image: 'test-image',
        ttlMs: 60_000,
        cpu: 1,
        memoryMb: 128,
        diskMb: 1,
      }, 'wrong-token'),
      /令牌被拒绝/,
    )

    // 没带令牌也不行
    await assert.rejects(
      () => plane.create({
        image: 'test-image',
        ttlMs: 60_000,
        cpu: 1,
        memoryMb: 128,
        diskMb: 1,
      }),
      /令牌被拒绝/,
    )

    // 令牌对了才能创建
    const handle = await plane.create({
      image: 'test-image',
      ttlMs: 60_000,
      cpu: 1,
      memoryMb: 128,
      diskMb: 1,
    }, 'caller-token-123456')
    assert.ok(handle.sandboxId)

    // 挂回也要校验。挂回会重新签发沙盒令牌,不能让外人拿到。
    await assert.rejects(
      () => plane.attach(handle.sandboxId, 60_000, 'session-1', 'wrong-token'),
      /令牌被拒绝/,
    )
  } finally {
    // 必须关掉:in-process 后端起了真的 daemon HTTP 服务,不关进程退不出去
    await plane.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('控制面没配调用方令牌时不校验,本进程场景不受影响', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grass-noauth-'))
  const plane = createControlPlane({
    backend: createInProcessBackend({ stateDir }),
    timer: idleTimer,
  })
  try {
    // 不带令牌也能创建——控制面只监听回环,外人连不上
    const handle = await plane.create({
      image: 'test-image',
      ttlMs: 60_000,
      cpu: 1,
      memoryMb: 128,
      diskMb: 1,
    })
    assert.ok(handle.sandboxId)
  } finally {
    // 必须关掉:in-process 后端起了真的 daemon HTTP 服务,不关进程退不出去
    await plane.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('空闲到期后调用失败,keep 的卷可以挂回,不存在的卷不会被新建', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grass-idle-'))
  try {
    let idle: (() => void) | undefined
    const plane = createControlPlane({
      backend: createInProcessBackend({ stateDir }),
      timer: (callback) => {
        idle = callback
        return { refresh() {}, cancel() {} }
      },
    })
    const handle = await plane.create({
      image: 'test-image',
      ttlMs: 60_000,
      cpu: 1,
      memoryMb: 128,
      diskMb: 1,
      keep: true,
    })
    const written = await plane.call(handle.sandboxId, handle.token, {
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'write',
      path: 'kept.txt',
      content: 'still-here',
    })
    assert.equal(written.ok, true)
    assert.ok(idle)
    idle?.()
    await waitUntil(async () => {
      const result = await plane.call(handle.sandboxId, handle.token, {
        version: SANDBOX_PROTOCOL_VERSION,
        kind: 'read',
        path: 'kept.txt',
      })
      return !result.ok && result.code === 'unavailable'
    })
    const workspace = path.join(stateDir, handle.sandboxId, 'workspace', 'kept.txt')
    assert.equal(await readFile(workspace, 'utf-8'), 'still-here')

    const attached = await plane.attach(handle.sandboxId, 60_000, 'session-2')
    const readBack = await plane.call(attached.sandboxId, attached.token, {
      version: SANDBOX_PROTOCOL_VERSION,
      kind: 'read',
      path: 'kept.txt',
    })
    assert.equal(readBack.ok && readBack.content, 'still-here')
    await plane.release(attached.sandboxId, attached.token)

    await assert.rejects(() => plane.attach('missing-sandbox', 60_000), /不能挂回/)
    await assert.rejects(() => stat(path.join(stateDir, 'missing-sandbox')))
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('docker 参数和克隆命令不携带令牌或密钥,失败时删掉未保留的目录', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'grass-docker-'))
  const secret = 'ghp_secretvalue'
  const apiKey = 'sk-live-secret'
  const seen: string[][] = []
  let tokenFile = ''
  try {
    const backend = createDockerBackend({
      stateDir,
      env: { PATH: '/usr/bin', GRASSAGENT_API_KEY: apiKey, GIT_TOKEN: secret },
      runner: {
        async run(argv, options) {
          seen.push([...argv])
          const rendered = `${argv.join('\n')}\n${JSON.stringify(options?.env ?? {})}\n${options?.stdin ?? ''}`
          assert.equal(rendered.includes(secret), false, rendered)
          assert.equal(rendered.includes(apiKey), false, rendered)
          if (argv[1] === 'run') {
            const envFlag = argv.indexOf('--env-file')
            const envText = await readFile(argv[envFlag + 1], 'utf-8')
            assert.equal(envText.includes(apiKey), false)
            assert.equal(envText.includes(secret), false)
            const mount = argv.find((item) => item.includes(':/run/grass/token:ro'))
            assert.ok(mount)
            tokenFile = mount.slice(0, mount.indexOf(':/run/grass/token:ro'))
            const info = await stat(tokenFile)
            // Windows 没有 POSIX 权限位,Node 报出来的是 0666。0600 只在控制面所在的 Linux 上有意义。
            if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
            const token = await readFile(tokenFile, 'utf-8')
            assert.equal(argv.join('\n').includes(token), false)
            return { exitCode: 0, stdout: 'container\n', stderr: '' }
          }
          if (argv.includes('--proxy')) {
            return { exitCode: 0, stdout: JSON.stringify({ ok: true, version: 999 }), stderr: '' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })
    await assert.rejects(
      () => backend.provision({
        sandboxId: 'box1',
        token: 'sandbox-token-value',
        image: 'node:22',
        repoUrl: 'https://example.com/demo.git',
        credential: secret,
        cpu: 1,
        memoryMb: 512,
        diskMb: 100,
        networkAllowlist: [],
        keep: false,
      }),
      /版本不符/,
    )
    assert.equal(seen.some((argv) => argv[0] === 'git' && argv.includes('https://example.com/demo.git')), true)
    assert.equal(seen.some((argv) => argv.includes('rm') && argv.includes('-f')), true)
    await assert.rejects(() => stat(path.join(stateDir, 'box1')))
    const run = seen.find((argv) => argv[1] === 'run')
    assert.ok(run)
    assert.ok(run.includes('--network'))
    assert.ok(run.includes('none'))
    assert.ok(run.includes('--read-only'))
    assert.ok(run.includes('512m'))
    assert.equal(run.includes('sandbox-token-value'), false)

    await assert.rejects(
      () => backend.provision({
        sandboxId: 'box2',
        token: 'another-token-value',
        image: 'node:22',
        repoUrl: '',
        credential: null,
        cpu: 1,
        memoryMb: 128,
        diskMb: 10,
        networkAllowlist: ['example.com:443'],
        keep: false,
      }),
      /出站白名单/,
    )
    assert.equal(seen.some((argv) => argv.includes('box2') && argv[1] === 'run'), false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('容器环境文件会丢掉密钥名字,docker 参数本身也不含密钥', () => {
  const lines = containerEnvLines({
    PATH: '/usr/bin',
    GRASSAGENT_API_KEY: 'sk-live-secret',
    GIT_TOKEN: 'ghp_secretvalue',
  })
  assert.match(lines, /PATH=\/usr\/bin/)
  assert.equal(lines.includes('sk-live-secret'), false)
  assert.equal(lines.includes('ghp_secretvalue'), false)
  const args = dockerRunArguments({
    name: 'grass-box',
    image: 'node:22',
    workspaceDir: '/tmp/work',
    tokenFile: '/tmp/token',
    sourceDir: '/tmp/src',
    envFile: '/tmp/env',
    cpu: 1,
    memoryMb: 256,
    diskMb: 10,
    user: '1000:1000',
  })
  assert.equal(args.join('\n').includes('sk-live-secret'), false)
  assert.ok(args.includes('--network'))
  assert.ok(args.includes('none'))
})

test('凭据文件权限不是 0600 时拒绝读取', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-cred-'))
  try {
    const filePath = path.join(directory, 'creds.json')
    await writeSecretFile(filePath, JSON.stringify({ github: 'ghp_secretvalue' }))
    const { chmod } = await import('node:fs/promises')
    await chmod(filePath, 0o644)
    const { resolveCredentialRef } = await import('../src/sandbox/secrets.ts')
    await assert.rejects(() => resolveCredentialRef('github', filePath), /0600/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function readdirOrEmpty(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return readdir(directory).catch(() => [])
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('条件没有在预期内成立')
}
