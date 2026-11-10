// src/core/validation.ts
// 参数校验层 —— 用 pi-schema 校验模型给的工具参数。
//
// 为什么要有这一层:模型给的参数是不可信输入。它可能把数字写成字符串、
// 漏掉必填字段、给出多余的字段。直接执行的话,write_file 会拿到 undefined 路径乱写。
//
// 两个关键设计:
// 1. coerce:true —— 宽松类型自动纠正。模型传 "42" 当数字用,直接转成 42,
//    不必为此多跑一轮。只有转不了(比如 "abc" 当数字)才算校验失败。
// 2. 校验失败不抛异常终止循环,而是把错误文本回填给 context,让模型自己纠正后重发。
//    和现有的 argsInvalid / max_tokens 处理路径是同一套机制。

import { compile, type CoercingValidator } from '@earendil-works/pi-schema'
import { formats } from '@earendil-works/pi-schema/formats'
import { jsonValueProblem, stringifyJson } from './jsonSafety.ts'

// 每个 schema 编译一次。工具 schema 是长生命周期的,
// 用 WeakMap 让 schema 对象被回收时对应的 validator 一起回收。
const validatorCache = new WeakMap<object, CoercingValidator<unknown>>()

// 编译一个 schema。schema 必须是对象(工具参数 schema 都是对象)。
function getValidator(schema: object): CoercingValidator<unknown> {
  const cached = validatorCache.get(schema)
  if (cached) return cached
  const validator = compile(schema, {
    formats,
    coerce: true,
    // 悬空的 $ref 只让该位置失败,不会让整个 schema 编译失败
    unresolvedRefs: 'reject',
  }) as CoercingValidator<unknown>
  validatorCache.set(schema, validator)
  return validator
}

/** 校验结果 */
export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * 把 JSON Pointer 形式的错误路径转成模型看得懂的点号路径。
 * `/edits/0/oldText` -> `edits.0.oldText`
 */
function formatValidationPath(pointer: string): string {
  if (pointer === '') return 'root'
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.')
}

/**
 * 校验工具参数。
 *
 * @param schema 工具的 JSON Schema
 * @param arguments_ 模型给的参数
 * @param toolName 工具名,用于错误提示
 */
export function validateToolArguments(
  schema: object,
  arguments_: unknown,
  toolName: string,
): ValidationResult {
  let validator: CoercingValidator<unknown>
  try {
    validator = getValidator(schema)
  } catch (error) {
    // schema 本身有问题(比如悬空 $ref)——这是开发错误,不是模型的问题。
    // 兜底:跳过校验让工具自己处理,不能因为 schema 写错就让 agent 崩掉。
    return {
      ok: false,
      error: `工具 "${toolName}" 的参数 schema 无效,已跳过校验: ${(error as Error).message}`,
    }
  }

  // 拷贝和校验都会往下走。过深的参数先拒掉,避免 structuredClone 或错误信息里的序列化把栈打穿。
  const problem = jsonValueProblem(arguments_)
  if (problem) {
    const reason = problem === 'circular' ? '参数含有循环引用' : '参数嵌套过深'
    return { ok: false, error: `工具 "${toolName}" ${reason},请简化后重新调用。` }
  }

  // 拷贝一份再校验,避免工具修改参数时污染 transcript 里的原始记录
  const result = validator.parse(structuredClone(arguments_))
  if (result.ok) return { ok: true, value: result.value }

  const details = result.errors
    .map((validationError) => `  - ${formatValidationPath(validationError.path)}: ${validationError.message}`)
    .join('\n')

  const error = `工具 "${toolName}" 参数校验失败。修正后重新调用。\n${details}\n\n收到的参数:\n${stringifyJson(arguments_)}`
  return { ok: false, error }
}

/**
 * 校验并返回格式化后的错误文本,校验通过则返回 undefined。
 * agent 层用这个:拿到 undefined 就执行,拿到文本就回填给模型。
 */
export function checkToolArguments(
  schema: object,
  arguments_: unknown,
  toolName: string,
): string | undefined {
  const result = validateToolArguments(schema, arguments_, toolName)
  return result.ok ? undefined : result.error
}
