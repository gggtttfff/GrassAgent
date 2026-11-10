import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../../src/core/logger.ts'

// 收集日志输出的内存流
function createCollectingStream(): { stream: { write(message: string): void }; lines: string[] } {
  const lines: string[] = []
  return {
    stream: { write(message: string): void { lines.push(message.trim()) } },
    lines,
  }
}

test('json 格式输出结构化字段', () => {
  const collector = createCollectingStream()
  const logger = createLogger({ level: 'info', format: 'json', destination: collector.stream })
  logger.info({ model: 'test-model', count: 3 }, '启动完成')

  assert.equal(collector.lines.length, 1)
  const entry = JSON.parse(collector.lines[0]) as Record<string, unknown>
  assert.equal(entry.msg, '启动完成')
  assert.equal(entry.model, 'test-model')
  assert.equal(entry.count, 3)
  assert.equal(entry.service, 'grassagent')
})

test('apiKey 字段被脱敏', () => {
  const collector = createCollectingStream()
  const logger = createLogger({ level: 'info', format: 'json', destination: collector.stream })
  logger.info({ apiKey: 'sk-secret-value' }, '配置')

  const entry = JSON.parse(collector.lines[0]) as Record<string, unknown>
  assert.equal(entry.apiKey, '[REDACTED]')
  assert.ok(!collector.lines[0].includes('sk-secret-value'), '密钥不应出现在日志里')
})

test('日志级别过滤掉低于阈值的信息', () => {
  const collector = createCollectingStream()
  const logger = createLogger({ level: 'warn', format: 'json', destination: collector.stream })
  logger.info({ a: 1 }, '不该出现')
  logger.warn({ b: 2 }, '应该出现')

  assert.equal(collector.lines.length, 1)
  const entry = JSON.parse(collector.lines[0]) as Record<string, unknown>
  assert.equal(entry.msg, '应该出现')
})

test('pretty 格式转成可读单行文本', () => {
  const collector = createCollectingStream()
  const logger = createLogger({ level: 'info', format: 'pretty', destination: collector.stream })
  logger.info({ model: 'test-model' }, '启动完成')

  assert.equal(collector.lines.length, 1)
  const line = collector.lines[0]
  assert.ok(line.includes('启动完成'), `实际: ${line}`)
  assert.ok(line.includes('model=test-model'), `实际: ${line}`)
  assert.ok(line.includes('INFO'), `实际: ${line}`)
})

test('pretty 格式把嵌套对象序列化成 JSON', () => {
  const collector = createCollectingStream()
  const logger = createLogger({ level: 'info', format: 'pretty', destination: collector.stream })
  logger.info({ details: { a: 1 } }, '嵌套')

  assert.ok(collector.lines[0].includes('details={"a":1}'), `实际: ${collector.lines[0]}`)
})

test('Logger 暴露了标准级别方法', () => {
  const logger = createLogger({ level: 'info', format: 'json' })
  for (const method of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
    assert.equal(typeof logger[method as 'info'], 'function', `${method} 应当可用`)
  }
})
