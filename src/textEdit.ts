// src/textEdit.ts
// 唯一替换只写在这一处。本地世界和远端 daemon 共用,
// 避免「检查」和「写入」分两次往返时规则漂掉。

/** 某一处替换没有唯一命中。文件还没被写。 */
export class TextEditError extends Error {
  readonly reason: 'not_found' | 'not_unique'
  readonly index: number
  readonly count: number
  readonly filePath: string

  constructor(details: {
    reason: 'not_found' | 'not_unique'
    index: number
    count: number
    filePath: string
  }) {
    super(details.reason === 'not_found' ? 'old_string not found' : 'old_string not unique')
    this.name = 'TextEditError'
    this.reason = details.reason
    this.index = details.index
    this.count = details.count
    this.filePath = details.filePath
  }
}

/**
 * 统计子串出现次数。按出现位置往后找,重叠匹配不重复计数。
 * 空串没有稳定的「唯一位置」,直接算 0,让编辑报找不到。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function countOccurrences(content: string, target: string): number {
  if (!target) return 0
  let count = 0
  let searchFrom = 0
  while (true) {
    const found = content.indexOf(target, searchFrom)
    if (found < 0) break
    count++
    searchFrom = found + target.length
  }
  return count
}

/**
 * 按顺序把全部替换应用到内存里的文本上。
 * 任一处找不到或不是唯一匹配就抛错,调用方这时还没写文件。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function applyEdits(
  content: string,
  edits: readonly { old_string: string; new_string: string }[],
  filePath: string,
): string {
  let result = content
  for (let index = 0; index < edits.length; index++) {
    const { old_string, new_string } = edits[index]
    const count = countOccurrences(result, old_string)
    if (count === 0) {
      throw new TextEditError({ reason: 'not_found', index, count, filePath })
    }
    if (count > 1) {
      throw new TextEditError({ reason: 'not_unique', index, count, filePath })
    }
    // 用函数替换,避免 new_string 里的 $& 被 String.replace 当成整段匹配
    result = result.replace(old_string, () => new_string)
  }
  return result
}
