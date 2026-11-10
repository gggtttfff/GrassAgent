import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui'
import { SlashCommandRegistry, parseSlashCommand } from '../../src/ui/slashCommands.ts'

// 斜杠命令的测试。
//
// 关键点:命令在本地执行,不发给模型;
// 命令名拼错也要拦下来,不能当成普通输入发给模型。

test('parseSlashCommand 认出命令名和参数', () => {
  assert.deepEqual(parseSlashCommand('/clear'), { kind: 'command', name: 'clear', argument: '' })
  assert.deepEqual(parseSlashCommand('/resume abc'), { kind: 'command', name: 'resume', argument: 'abc' })
  // 参数里的空格保留
  assert.deepEqual(parseSlashCommand('/say hello world'), { kind: 'command', name: 'say', argument: 'hello world' })
})

test('parseSlashCommand 不认普通输入', () => {
  assert.equal(parseSlashCommand('你好').kind, 'not_a_command')
  assert.equal(parseSlashCommand('').kind, 'not_a_command')
  // 只有斜杠没有命令名
  assert.equal(parseSlashCommand('/').kind, 'not_a_command')
  assert.equal(parseSlashCommand('  ').kind, 'not_a_command')
})

test('parseSlashCommand 只看第一行', () => {
  // 多行输入里第二行开始的 / 是正文,不是命令
  const parsed = parseSlashCommand('/clear\n/这不是命令')
  assert.equal(parsed.kind, 'command')
  assert.equal((parsed as { name: string }).name, 'clear')
})

test('execute 执行命令并返回结果', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({
    name: 'clear',
    description: '清空',
    execute: () => '已清空',
  })

  const result = await registry.execute('/clear')
  assert.equal(result, '已清空')
})

test('execute 传参数给命令', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({
    name: 'echo',
    description: '回显',
    execute: (argument) => `收到:${argument}`,
  })

  assert.equal(await registry.execute('/echo hello'), '收到:hello')
})

test('execute 对普通输入返回 null', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({ name: 'clear', description: '清空', execute: () => 'x' })

  assert.equal(await registry.execute('普通输入'), null)
})

test('execute 未知命令给出提示,不返回 null', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({ name: 'clear', description: '清空', execute: () => 'x' })

  const result = await registry.execute('/nope')
  // 关键:不能是 null,不然会被当成普通输入发给模型
  assert.notEqual(result, null)
  assert.ok(String(result).includes('/nope'))
  assert.ok(String(result).includes('/clear'), '提示里应该列出可用命令')
})

test('execute 命令抛异常时兜底成错误文本', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({
    name: 'boom',
    description: '会炸',
    execute: () => {
      throw new Error('炸了')
    },
  })

  const result = await registry.execute('/boom')
  assert.notEqual(result, null)
  assert.ok(String(result).includes('炸了'))
})

test('execute 支持异步命令', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({
    name: 'async',
    description: '异步',
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return '异步完成'
    },
  })

  assert.equal(await registry.execute('/async'), '异步完成')
})

test('命令名按字母序排', () => {
  const registry = new SlashCommandRegistry()
  registry.register({ name: 'resume', description: 'x', execute: () => '' })
  registry.register({ name: 'clear', description: 'x', execute: () => '' })
  registry.register({ name: 'new', description: 'x', execute: () => '' })

  assert.deepEqual(registry.names(), ['clear', 'new', 'resume'])
})

test('同名命令会被覆盖', () => {
  const registry = new SlashCommandRegistry()
  registry.register({ name: 'clear', description: '第一个', execute: () => 'first' })
  registry.register({ name: 'clear', description: '第二个', execute: () => 'second' })

  assert.equal(registry.names().length, 1)
  assert.equal(registry.find('clear')?.description, '第二个')
})

test('all 返回全部命令,带名称和说明', () => {
  const registry = new SlashCommandRegistry()
  registry.register({ name: 'clear', description: '清空对话', execute: () => '' })
  registry.register({ name: 'resume', description: '切换会话', argumentHint: '[ID]', execute: () => '' })

  const all = registry.all()
  assert.equal(all.length, 2)
  assert.ok(all.every((command) => typeof command.name === 'string'))
  assert.ok(all.every((command) => typeof command.description === 'string'))
})

// 命令补全:输入 / 时应该弹出命令列表
test('输入斜杠时补全列表给出所有命令', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({ name: 'clear', description: '清空对话', execute: () => '' })
  registry.register({ name: 'sessions', description: '列出会话', execute: () => '' })

  const provider = new CombinedAutocompleteProvider(
    registry.all().map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
    })),
    process.cwd(),
  )

  const suggestions = await provider.getSuggestions(['/'], 0, 1, {
    signal: new AbortController().signal,
  })

  assert.ok(suggestions, '应该给出补全建议')
  const names = suggestions.items.map((item) => item.value)
  assert.ok(names.includes('clear'))
  assert.ok(names.includes('sessions'))
})

test('补全列表按前缀过滤', async () => {
  const registry = new SlashCommandRegistry()
  registry.register({ name: 'clear', description: '清空对话', execute: () => '' })
  registry.register({ name: 'sessions', description: '列出会话', execute: () => '' })

  const provider = new CombinedAutocompleteProvider(
    registry.all().map((command) => ({ name: command.name, description: command.description })),
    process.cwd(),
  )

  const suggestions = await provider.getSuggestions(['/se'], 0, 3, {
    signal: new AbortController().signal,
  })

  assert.ok(suggestions)
  const names = suggestions.items.map((item) => item.value)
  assert.ok(names.includes('sessions'))
  assert.ok(!names.includes('clear'), '不匹配的命令不该出现')
})
