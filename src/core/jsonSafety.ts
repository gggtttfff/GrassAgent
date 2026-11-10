// src/core/jsonSafety.ts
// 不可信 JSON 的深度护栏。
//
// JSON.parse 对极深的数组是成功的,对象图会建出来。
// 之后的 JSON.stringify(落盘、导出、压缩、发给模型)是递归的,
// 嵌套到大约几千层就会 RangeError,而且往往发生在事务或请求中途。
// 在固定栈上先量深度,超过上限直接拒绝,不把这种值留在内存里。

export const MAX_JSON_DEPTH = 256

export class JsonSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonSafetyError'
  }
}

/**
 * 文本里的容器是否超过 maxDepth。
 * 只数字符串外面的 `{` `[`,字符串里的括号和转义都不算。
 */
export function jsonTextExceedsDepth(text: string, maxDepth = MAX_JSON_DEPTH): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      if (depth > maxDepth) return true
      continue
    }
    if ((char === '}' || char === ']') && depth > 0) depth -= 1
  }
  return false
}

/** 先量深度再解析。超深抛 JsonSafetyError,语法错误仍是 SyntaxError。 */
export function parseJson(text: string, maxDepth = MAX_JSON_DEPTH): unknown {
  if (jsonTextExceedsDepth(text, maxDepth)) {
    throw new JsonSafetyError(`JSON 嵌套超过 ${maxDepth} 层,已拒绝解析`)
  }
  return JSON.parse(text)
}

/**
 * 已经在内存里的值是否过深或成环。
 * 用堆上的栈往下走,不递归。环直接返回,避免沿着环把深度加到溢出。
 */
export function jsonValueProblem(
  value: unknown,
  maxDepth = MAX_JSON_DEPTH,
): 'too-deep' | 'circular' | null {
  if (!value || typeof value !== 'object') return null
  const seen = new WeakSet<object>()
  const stack: Array<{ value: object; depth: number }> = [{ value, depth: 1 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (current.depth > maxDepth) return 'too-deep'
    if (seen.has(current.value)) return 'circular'
    seen.add(current.value)
    const children = Array.isArray(current.value)
      ? current.value
      : Object.keys(current.value).map((key) => (current.value as Record<string, unknown>)[key])
    for (const child of children) {
      if (child && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return null
}

export function assertJsonValue(value: unknown, maxDepth = MAX_JSON_DEPTH): void {
  const problem = jsonValueProblem(value, maxDepth)
  if (problem === 'too-deep') {
    throw new JsonSafetyError(`JSON 嵌套超过 ${maxDepth} 层,已拒绝序列化`)
  }
  if (problem === 'circular') {
    throw new JsonSafetyError('JSON 含有循环引用,已拒绝序列化')
  }
}

/** 确认深度和成环之后再序列化,避免 JSON.stringify 自己递归爆栈。 */
export function stringifyJson(value: unknown, maxDepth = MAX_JSON_DEPTH): string {
  assertJsonValue(value, maxDepth)
  return JSON.stringify(value)
}
