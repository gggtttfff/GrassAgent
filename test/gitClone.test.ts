import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { classifyRepoUrl, cloneRepository, sshCommand } from '../src/sandbox/gitClone.ts'
import type { CommandRunner } from '../src/sandbox/commandRunner.ts'

// 仓库克隆的测试。
//
// 只测「怎么判断地址」和「给 git 什么环境」——不真的联网克隆。
// 假 runner 记下收到的 argv 和 env,用来确认凭据没进参数。

type Captured = {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
}

function fakeRunner(exitCode = 0): { runner: CommandRunner, calls: Captured[] } {
  const calls: Captured[] = []
  const runner: CommandRunner = {
    async run(argv, options) {
      calls.push({ argv, env: options?.env ?? {} })
      return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'clone failed' }
    },
  }
  return { runner, calls }
}

test('HTTPS 地址认成 http', () => {
  assert.equal(classifyRepoUrl('https://github.com/foo/bar.git'), 'http')
  assert.equal(classifyRepoUrl('http://example.com/foo.git'), 'http')
})

test('scp 风格的 git@host:path 认成 ssh,不当成坏地址', () => {
  assert.equal(classifyRepoUrl('git@github.com:foo/bar.git'), 'ssh')
  assert.equal(classifyRepoUrl('dev@example.com:/srv/repo.git'), 'ssh')
})

test('ssh:// 开头的地址认成 ssh', () => {
  assert.equal(classifyRepoUrl('ssh://git@github.com/foo/bar.git'), 'ssh')
})

test('HTTPS 地址里内嵌凭据要被拒', () => {
  assert.throws(() => classifyRepoUrl('https://user:pass@example.com/foo.git'), /不能携带凭据/)
  assert.throws(() => classifyRepoUrl('https://token@example.com/foo.git'), /不能携带凭据/)
})

test('地址为空或不是合法 URL 要报错', () => {
  assert.throws(() => classifyRepoUrl('   '), /不能为空/)
  assert.throws(() => classifyRepoUrl('not a url'), /不是合法 URL/)
})

test('ssh 命令带 BatchMode,缺密钥时立刻失败而不是挂住', () => {
  const command = sshCommand('/tmp/key')
  assert.match(command, /-i '\/tmp\/key'/)
  assert.match(command, /BatchMode=yes/)
  assert.match(command, /IdentitiesOnly=yes/)
})

test('ssh 命令挡住路径里的单引号', () => {
  const command = sshCommand("/tmp/it's/key")
  assert.match(command, /'\/tmp\/it'\\''s\/key'/)
})

test('HTTPS 克隆:令牌走 askpass,不进命令行参数', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-clone-'))
  try {
    const { runner, calls } = fakeRunner()
    await cloneRepository({
      repoUrl: 'https://github.com/foo/bar.git',
      destination: path.join(directory, 'dest'),
      token: 'ghp_secret_token_value',
      runner,
      secretDirectory: path.join(directory, 'secret'),
    })
    assert.equal(calls.length, 1)
    // 令牌不能出现在 argv 里,那会进远程的进程列表
    const argvText = calls[0].argv.join(' ')
    assert.equal(argvText.includes('ghp_secret_token_value'), false)
    assert.equal(calls[0].env.GIT_ASKPASS !== undefined, true)
    assert.equal(calls[0].env.GRASS_GIT_TOKEN_FILE !== undefined, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('SSH 克隆:私钥写进临时文件,用 GIT_SSH_COMMAND 指定', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-clone-ssh-'))
  try {
    const { runner, calls } = fakeRunner()
    await cloneRepository({
      repoUrl: 'git@github.com:foo/bar.git',
      destination: path.join(directory, 'dest'),
      token: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----',
      runner,
      secretDirectory: path.join(directory, 'secret'),
    })
    assert.equal(calls.length, 1)
    // 私钥不能出现在 argv 里
    const argvText = calls[0].argv.join(' ')
    assert.equal(argvText.includes('BEGIN OPENSSH PRIVATE KEY'), false)
    // 走 SSH 时不该配 askpass
    assert.equal(calls[0].env.GIT_ASKPASS, undefined)
    assert.match(calls[0].env.GIT_SSH_COMMAND ?? '', /-i '.*ssh-key'/)
    assert.match(calls[0].env.GIT_SSH_COMMAND ?? '', /BatchMode=yes/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('克隆完把临时凭据文件删掉', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-clone-cleanup-'))
  try {
    const secretDirectory = path.join(directory, 'secret')
    const { runner } = fakeRunner()
    await cloneRepository({
      repoUrl: 'git@github.com:foo/bar.git',
      destination: path.join(directory, 'dest'),
      token: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----',
      runner,
      secretDirectory,
    })
    // 私钥文件用完就删
    const keyExists = await stat(path.join(secretDirectory, 'ssh-key')).then(() => true, () => false)
    assert.equal(keyExists, false, '私钥临时文件应该被删掉')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('克隆失败时报错并删掉半成品目录', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-clone-fail-'))
  try {
    const { runner } = fakeRunner(128)
    await assert.rejects(
      () => cloneRepository({
        repoUrl: 'https://github.com/foo/bar.git',
        destination: path.join(directory, 'dest'),
        token: null,
        runner,
        secretDirectory: path.join(directory, 'secret'),
      }),
      /克隆仓库失败/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('没有凭据时不写任何临时文件', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grass-clone-none-'))
  try {
    const { runner, calls } = fakeRunner()
    await cloneRepository({
      repoUrl: 'https://github.com/foo/bar.git',
      destination: path.join(directory, 'dest'),
      token: null,
      runner,
      secretDirectory: path.join(directory, 'secret'),
    })
    assert.equal(calls[0].env.GIT_ASKPASS, undefined)
    assert.equal(calls[0].env.GIT_SSH_COMMAND, undefined)
    const tokenExists = await stat(path.join(directory, 'secret', 'git-token'))
      .then(() => true, () => false)
    assert.equal(tokenExists, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})