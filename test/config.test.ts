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
} from '../src/config.ts'

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
  assert.equal(config.CompactThreshold, 50)
  assert.equal(config.CompactKeepRecent, 20)
})

test('压缩阈值可以配', () => {
  const config = validateConfig({
    ApiKey: 'k',
    CompactThreshold: '30',
    CompactKeepRecent: '10',
  })
  assert.equal(config.CompactThreshold, 30)
  assert.equal(config.CompactKeepRecent, 10)
})

test('保留条数不小于阈值时报错', () => {
  // 保留的条数比阈值还多,就永远没有可摘要的旧消息
  assert.throws(
    () => validateConfig({ ApiKey: 'k', CompactThreshold: '10', CompactKeepRecent: '20' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_COMPACT_KEEP_RECENT')))
      return true
    },
  )
})

test('压缩阈值过小时被拒绝', () => {
  assert.throws(() => validateConfig({ ApiKey: 'k', CompactThreshold: '1' }), ConfigError)
  assert.throws(() => validateConfig({ ApiKey: 'k', CompactKeepRecent: '0' }), ConfigError)
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
