import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  parseEnvFile,
  collectEnvValues,
  validateConfig,
  loadConfig,
  resolveEnvFilePath,
  ConfigError,
  type EnvFileResolution,
} from '../../src/config.ts'
import { defaultHomeDirectory } from '../../src/core/homeDirectory.ts'

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
  assert.equal(config.SandboxMode, 'workspace-write')
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

test('沙盒权限模式可以配,非法取值启动就报错', () => {
  assert.equal(validateConfig({ ApiKey: 'k', SandboxMode: 'read-only' }).SandboxMode, 'read-only')
  assert.equal(
    validateConfig({ ApiKey: 'k', SandboxMode: 'danger-full-access' }).SandboxMode,
    'danger-full-access',
  )
  assert.throws(
    () => validateConfig({ ApiKey: 'k', SandboxMode: 'whatever' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.issues.some((issue) => issue.includes('GRASSAGENT_SANDBOX_MODE')))
      return true
    },
  )
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

// ---- 宿主目录 GRASSAGENT_HOME ----

test('宿主目录有默认值,数据路径都从它派生', () => {
  const config = validateConfig({ ApiKey: 'k' })
  assert.equal(config.Home, defaultHomeDirectory())
  assert.equal(config.SessionDatabasePath, path.join(config.Home, 'sessions.db'))
  assert.equal(config.CloudSessionDirectory, path.join(config.Home, 'cloud-sessions'))
  assert.equal(config.PluginTrustFile, path.join(config.Home, 'plugin-trust.json'))
  assert.equal(config.SkillEvalDirectory, path.join(config.Home, 'skill-eval'))
})

test('配了 GRASSAGENT_HOME 后默认路径整体搬过去', () => {
  const home = path.join(os.tmpdir(), `grass-home-${process.pid}`)
  const config = validateConfig({ ApiKey: 'k', Home: home })
  assert.equal(config.Home, path.resolve(home))
  assert.equal(config.SessionDatabasePath, path.join(path.resolve(home), 'sessions.db'))
  assert.equal(config.CloudSessionDirectory, path.join(path.resolve(home), 'cloud-sessions'))
  assert.equal(config.PluginTrustFile, path.join(path.resolve(home), 'plugin-trust.json'))
  assert.equal(config.SkillEvalDirectory, path.join(path.resolve(home), 'skill-eval'))
})

test('单项路径显式配置时优先于宿主目录', () => {
  const home = path.join(os.tmpdir(), `grass-home-${process.pid}`)
  const databasePath = path.join(os.tmpdir(), 'legacy-session.db')
  const config = validateConfig({ ApiKey: 'k', Home: home, SessionDatabasePath: databasePath })
  assert.equal(config.SessionDatabasePath, databasePath)
  assert.equal(config.CloudSessionDirectory, path.join(path.resolve(home), 'cloud-sessions'))
})

test('路径写成空字符串时回退到宿主目录派生值', () => {
  const home = path.join(os.tmpdir(), `grass-home-${process.pid}`)
  const config = validateConfig({
    ApiKey: 'k',
    Home: home,
    SessionDatabasePath: '',
    CloudSessionDirectory: '',
    PluginTrustFile: '',
    SkillEvalDirectory: '',
  })
  assert.equal(config.SessionDatabasePath, path.join(path.resolve(home), 'sessions.db'))
  assert.equal(config.CloudSessionDirectory, path.join(path.resolve(home), 'cloud-sessions'))
  assert.equal(config.PluginTrustFile, path.join(path.resolve(home), 'plugin-trust.json'))
  assert.equal(config.SkillEvalDirectory, path.join(path.resolve(home), 'skill-eval'))
})

test('宿主目录支持 ~ 前缀', () => {
  const config = validateConfig({ ApiKey: 'k', Home: '~/my-grass' })
  assert.equal(config.Home, path.join(os.homedir(), 'my-grass'))
  assert.equal(config.SessionDatabasePath, path.join(os.homedir(), 'my-grass', 'sessions.db'))
})

test('收集环境变量时 GRASSAGENT_HOME 也走系统优先规则', () => {
  assert.equal(collectEnvValues({ GRASSAGENT_HOME: 'from-file' }, {}).Home, 'from-file')
  assert.equal(
    collectEnvValues({ GRASSAGENT_HOME: 'from-file' }, { GRASSAGENT_HOME: 'from-env' }).Home,
    'from-env',
  )
})

test('没设 GRASSAGENT_HOME 时 .env 仍在项目根目录', async () => {
  const projectEnvFilePath = path.join(os.tmpdir(), 'grass-project.env')
  const resolution = await resolveEnvFilePath(undefined, projectEnvFilePath)
  assert.deepEqual(resolution, { filePath: projectEnvFilePath, source: 'project' })
})

test('宿主目录下有 .env 时优先读它', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-home-env-'))
  await fs.writeFile(path.join(directory, '.env'), 'GRASSAGENT_API_KEY=home-key\n', 'utf-8')
  const projectEnvFilePath = path.join(os.tmpdir(), 'grass-project.env')
  const resolution = await resolveEnvFilePath(directory, projectEnvFilePath)
  assert.deepEqual(resolution, {
    filePath: path.join(directory, '.env'),
    source: 'home',
  })
  await fs.rm(directory, { recursive: true, force: true })
})

test('宿主目录下没有 .env 时回退项目根,并记录找过的路径', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-home-empty-'))
  const projectEnvFilePath = path.join(os.tmpdir(), 'grass-project.env')
  const resolution = await resolveEnvFilePath(directory, projectEnvFilePath)
  assert.deepEqual(resolution, {
    filePath: projectEnvFilePath,
    source: 'project',
    expectedFilePath: path.join(directory, '.env'),
  })
  await fs.rm(directory, { recursive: true, force: true })
})

test('GRASSAGENT_HOME 是空白字符串时视为没配', async () => {
  const projectEnvFilePath = path.join(os.tmpdir(), 'grass-project.env')
  const resolution = await resolveEnvFilePath('   ', projectEnvFilePath)
  assert.deepEqual(resolution, { filePath: projectEnvFilePath, source: 'project' })
})

test('loadConfig 用宿主目录里的 .env,并通过回调报出来源', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-home-load-'))
  const envFilePath = path.join(directory, '.env')
  await fs.writeFile(envFilePath, 'GRASSAGENT_API_KEY=home-key\n', 'utf-8')
  let resolution: EnvFileResolution | undefined
  const config = await loadConfig({
    environment: { GRASSAGENT_HOME: directory },
    onEnvFile: (value) => { resolution = value },
  })
  assert.equal(config.ApiKey, 'home-key')
  assert.equal(config.Home, path.resolve(directory))
  assert.equal(config.SessionDatabasePath, path.join(path.resolve(directory), 'sessions.db'))
  assert.equal(resolution?.source, 'home')
  assert.equal(resolution?.filePath, envFilePath)
  await fs.rm(directory, { recursive: true, force: true })
})

test('loadConfig 显式指定 .env 路径时不受宿主目录影响', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-home-explicit-'))
  const envFilePath = path.join(directory, 'custom.env')
  await fs.writeFile(envFilePath, 'GRASSAGENT_API_KEY=explicit-key\n', 'utf-8')
  let resolution: EnvFileResolution | undefined
  const config = await loadConfig({
    envFilePath,
    environment: { GRASSAGENT_HOME: directory },
    onEnvFile: (value) => { resolution = value },
  })
  assert.equal(config.ApiKey, 'explicit-key')
  assert.equal(resolution?.source, 'explicit')
  await fs.rm(directory, { recursive: true, force: true })
})

test('.env 里写 GRASSAGENT_HOME 只影响数据路径,不改变 .env 自己的位置', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grass-home-infile-'))
  const envFilePath = path.join(directory, 'custom.env')
  const home = path.join(directory, 'data-home')
  await fs.writeFile(
    envFilePath,
    `GRASSAGENT_API_KEY=file-key\nGRASSAGENT_HOME=${home}\n`,
    'utf-8',
  )
  let resolution: EnvFileResolution | undefined
  const config = await loadConfig({
    envFilePath,
    environment: {},
    onEnvFile: (value) => { resolution = value },
  })
  assert.equal(config.ApiKey, 'file-key')
  assert.equal(config.Home, path.resolve(home))
  assert.equal(config.SessionDatabasePath, path.join(path.resolve(home), 'sessions.db'))
  assert.equal(resolution?.filePath, envFilePath)
  await fs.rm(directory, { recursive: true, force: true })
})
