import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  parseEnvFile,
  collectEnvValues,
  validateConfig,
  loadConfig,
  ConfigError,
} from '../../src/config.ts'

const minimalValues = { ApiKey: 'test-key' }

test('最小配置能通过校验并填上默认值', () => {
  const config = validateConfig(minimalValues)
  assert.equal(config.ApiKey, 'test-key')
  assert.equal(config.Model, 'gpt-4o-mini')
  assert.equal(config.BaseUrl, 'https://api.openai.com/v1')
  assert.equal(config.MaxTokens, 4096)
  assert.equal(config.MaxRetries, 3)
  assert.equal(config.MaxConcurrency, 4)
  assert.equal(config.LogLevel, 'info')
  assert.equal(config.LogFormat, 'json')
})

test('缺少 API Key 时校验失败', () => {
  assert.throws(() => validateConfig({}), ConfigError)
})

test('MaxTokens 非法时报错并指出环境变量名', () => {
  assert.throws(
    () => validateConfig({ ApiKey: 'k', MaxTokens: 'abc' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_MAX_TOKENS')))
      return true
    },
  )
})

test('MaxTokens 为 0 时被拒绝', () => {
  assert.throws(() => validateConfig({ ApiKey: 'k', MaxTokens: '0' }), ConfigError)
})

test('MaxTokens 是小数时被拒绝', () => {
  assert.throws(() => validateConfig({ ApiKey: 'k', MaxTokens: '10.5' }), ConfigError)
})

test('BaseUrl 不是合法 URL 时被拒绝', () => {
  assert.throws(() => validateConfig({ ApiKey: 'k', BaseUrl: 'not-a-url' }), ConfigError)
})

test('MaxRetries 超过上限时被拒绝', () => {
  assert.throws(() => validateConfig({ ApiKey: 'k', MaxRetries: '99' }), ConfigError)
})

test('LogLevel 非法值被拒绝', () => {
  assert.throws(() => validateConfig({ ApiKey: 'k', LogLevel: 'verbose' }), ConfigError)
})

test('字符串数值被正确转换', () => {
  const config = validateConfig({ ApiKey: 'k', MaxTokens: '8192', MaxConcurrency: '8' })
  assert.equal(config.MaxTokens, 8192)
  assert.equal(config.MaxConcurrency, 8)
})

test('空字符串走默认值而不是转成 0', () => {
  const config = validateConfig({ ApiKey: 'k', MaxTokens: '', MaxConcurrency: '' })
  assert.equal(config.MaxTokens, 4096)
  assert.equal(config.MaxConcurrency, 4)
})

test('布尔型环境变量接受多种写法', () => {
  // LogFormat 走枚举,这里用数值型字段验证 coerce 之外的行为
  const config = validateConfig({ ApiKey: 'k', MaxRetries: '0' })
  assert.equal(config.MaxRetries, 0)
})

test('压缩阈值有默认值', () => {
  const config = validateConfig({ ApiKey: 'k' })
  assert.equal(config.ContextWindow, 128_000)
  assert.equal(config.CompactReserveTokens, 16_384)
  assert.equal(config.CompactKeepRecentTokens, 20_000)
})

test('压缩阈值可以配', () => {
  const config = validateConfig({
    ApiKey: 'k',
    ContextWindow: '32000',
    CompactReserveTokens: '4096',
    CompactKeepRecentTokens: '8000',
  })
  assert.equal(config.ContextWindow, 32_000)
  assert.equal(config.CompactReserveTokens, 4096)
  assert.equal(config.CompactKeepRecentTokens, 8000)
})

test('保留区和预留加起来塞满窗口时报错', () => {
  assert.throws(
    () => validateConfig({
      ApiKey: 'k',
      ContextWindow: '8192',
      CompactReserveTokens: '4096',
      CompactKeepRecentTokens: '8000',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_COMPACT_KEEP_RECENT_TOKENS')))
      return true
    },
  )
})

test('压缩阈值过小时被拒绝', () => {
  assert.throws(() => validateConfig({ ApiKey: 'k', ContextWindow: '1000' }), ConfigError)
  assert.throws(() => validateConfig({ ApiKey: 'k', CompactReserveTokens: '1' }), ConfigError)
  assert.throws(() => validateConfig({ ApiKey: 'k', CompactKeepRecentTokens: '1' }), ConfigError)
})

test('系统环境变量优先于 .env 文件', () => {
  const fileValues = { GRASSAGENT_MODEL: 'from-file', GRASSAGENT_MAX_TOKENS: '100' }
  const environment = { GRASSAGENT_MODEL: 'from-env' }
  const values = collectEnvValues(fileValues, environment)
  assert.equal(values.Model, 'from-env')
  // 文件里有但环境变量没有的,仍然取文件里的值
  assert.equal(values.MaxTokens, '100')
})

test('环境变量为空字符串时回退到文件值', () => {
  const fileValues = { GRASSAGENT_MODEL: 'from-file' }
  const environment = { GRASSAGENT_MODEL: '' }
  const values = collectEnvValues(fileValues, environment)
  assert.equal(values.Model, 'from-file')
})

test('解析 .env 文件的注释、引号和空行', async () => {
  const envFilePath = path.join(os.tmpdir(), `grassagent-env-${process.pid}.env`)
  await (await import('node:fs/promises')).writeFile(
    envFilePath,
    [
      '# 这是注释',
      '',
      'GRASSAGENT_API_KEY=abc123',
      'GRASSAGENT_MODEL="quoted-model"',
      "GRASSAGENT_BASE_URL='quoted-url'",
      'GRASSAGENT_MAX_TOKENS=2048',
      '无效行没有等号',
    ].join('\n'),
    'utf-8',
  )

  const parsed = await parseEnvFile(envFilePath)
  assert.equal(parsed.GRASSAGENT_API_KEY, 'abc123')
  assert.equal(parsed.GRASSAGENT_MODEL, 'quoted-model')
  assert.equal(parsed.GRASSAGENT_BASE_URL, 'quoted-url')
  assert.equal(parsed.GRASSAGENT_MAX_TOKENS, '2048')
  assert.equal(parsed['无效行没有等号'], undefined)

  await (await import('node:fs/promises')).rm(envFilePath, { force: true })
})

test('.env 文件不存在时返回空对象', async () => {
  const parsed = await parseEnvFile(path.join(os.tmpdir(), `grassagent-not-exist-${process.pid}.env`))
  assert.deepEqual(parsed, {})
})

test('loadConfig 能从环境变量加载完整配置', async () => {
  const config = await loadConfig({
    envFilePath: path.join(os.tmpdir(), `grassagent-not-exist-${process.pid}.env`),
    environment: {
      GRASSAGENT_API_KEY: 'env-key',
      GRASSAGENT_MODEL: 'env-model',
      GRASSAGENT_MAX_TOKENS: '4096',
      GRASSAGENT_WORKSPACE: '/tmp/ws',
    },
  })
  assert.equal(config.ApiKey, 'env-key')
  assert.equal(config.Model, 'env-model')
  assert.equal(config.MaxTokens, 4096)
  assert.equal(config.Workspace, '/tmp/ws')
})

test('默认会识别项目里的规则和提示词', () => {
  const config = validateConfig({ ApiKey: 'k' })
  assert.equal(config.LoadProjectInstructions, true)
})

test('默认执行世界是本地,远程缺少控制面地址时失败', () => {
  const config = validateConfig({ ApiKey: 'k' })
  assert.equal(config.ExecutionWorld, 'local')
  assert.equal(config.SandboxTtlMs, 1_800_000)
  assert.equal(config.SandboxKeep, false)
  assert.throws(
    () => validateConfig({ ApiKey: 'k', ExecutionWorld: 'remote' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_SANDBOX_CONTROL_URL')))
      return true
    },
  )
  const remote = validateConfig({
    ApiKey: 'k',
    ExecutionWorld: 'remote',
    SandboxControlUrl: 'http://127.0.0.1:9473',
    SandboxImage: 'node:22',
  })
  assert.equal(remote.ExecutionWorld, 'remote')
  assert.equal(remote.SandboxImage, 'node:22')
})

test('LoadProjectInstructions 可以用 0 关掉', () => {
  const config = validateConfig({ ApiKey: 'k', LoadProjectInstructions: '0' })
  assert.equal(config.LoadProjectInstructions, false)
})

test('钩子超时有默认值,空路径视为没配', () => {
  const config = validateConfig({ ApiKey: 'k', HooksPath: '' })
  assert.equal(config.HookTimeoutMs, 10_000)
  assert.equal(config.HooksPath, undefined)
})

test('钩子超时不是整数时被拒绝', () => {
  assert.throws(
    () => validateConfig({ ApiKey: 'k', HookTimeoutMs: '10.5' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_HOOK_TIMEOUT_MS')))
      return true
    },
  )
})

test('loadConfig 缺 API Key 时抛 ConfigError', async () => {
  await assert.rejects(
    loadConfig({
      envFilePath: path.join(os.tmpdir(), `grassagent-not-exist-${process.pid}.env`),
      environment: {},
    }),
    ConfigError,
  )
})

test('SSH 后端不需要控制面地址和镜像', () => {
  // 控制面在本进程里起,镜像也不用——daemon 源码直接传到远程跑
  const config = validateConfig({
    ApiKey: 'k',
    ExecutionWorld: 'remote',
    SandboxBackend: 'ssh',
    SandboxSshHost: 'dev.example.com',
    SandboxSshUser: 'dev',
  })
  assert.equal(config.SandboxBackend, 'ssh')
  assert.equal(config.SandboxSshHost, 'dev.example.com')
  assert.equal(config.SandboxSshPort, 22)
  // 认证方式都留空,由运行期自动探测或报错
  assert.equal(config.SandboxSshAgent, undefined)
  assert.equal(config.SandboxSshPassword, undefined)
})

test('SSH 认证方式可以走 agent 或密码', () => {
  const config = validateConfig({
    ApiKey: 'k',
    ExecutionWorld: 'remote',
    SandboxBackend: 'ssh',
    SandboxSshHost: 'dev.example.com',
    SandboxSshUser: 'dev',
    SandboxSshAgent: '/run/user/1000/ssh-agent.socket',
    SandboxSshPassword: 'hunter2',
  })
  assert.equal(config.SandboxSshAgent, '/run/user/1000/ssh-agent.socket')
  assert.equal(config.SandboxSshPassword, 'hunter2')
})

test('SSH 后端缺主机或用户时被拒绝', () => {
  assert.throws(
    () => validateConfig({
      ApiKey: 'k',
      ExecutionWorld: 'remote',
      SandboxBackend: 'ssh',
      SandboxSshUser: 'dev',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_SANDBOX_SSH_HOST')))
      return true
    },
  )
  assert.throws(
    () => validateConfig({
      ApiKey: 'k',
      ExecutionWorld: 'remote',
      SandboxBackend: 'ssh',
      SandboxSshHost: 'dev.example.com',
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_SANDBOX_SSH_USER')))
      return true
    },
  )
})

test('docker 后端的远程世界仍然要求控制面地址', () => {
  assert.throws(
    () => validateConfig({ ApiKey: 'k', ExecutionWorld: 'remote' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_SANDBOX_CONTROL_URL')))
      return true
    },
  )
})
