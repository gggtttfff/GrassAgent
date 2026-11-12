// 分级反馈钩子示例 —— 把工具输出按严重度分级,只在该出声的时候出声。
//
// 放在 .grass/hooks.json 里:
// {
//   "PostToolUse": [
//     { "matcher": "run_bash", "hooks": [{ "type": "command", "command": "node .grass/hooks/grade-feedback.mjs" }] }
//   ]
// }
//
// 为什么要分级:一次改动跑下来可能有几十条 lint 警告和几个真错误。
// 全量塞回上下文,模型会来回横跳——修一个 lint 弄坏一个测试,
// 最后忘了任务本身。
//
// 规则:
//   阻塞级  不修就没法继续(编译失败、测试挂了、数据错了)。完整输出。
//   警告级  该修但不阻塞(lint 风格、字数偏差)。按规则名汇总,报个数。
//   信息级  成功消息、普通日志。静默。
//
// 成功静默是第一原则。反馈一多就等于没反馈。
//
// 输入(来自 stdin 的 JSON):
//   tool_output  工具原始输出。
//
// 输出(写到 stdout 的 JSON):
//   { "hookSpecificOutput": { "hookEventName": "PostToolUse", "updatedOutput": "分级后的文本" } }
//
// updatedOutput 会替换模型看到的内容。原文如果很长,
// 要在里面保留「全文在临时文件」那一行,不然模型就查不到了。

const BLOCKING_PATTERN = /\b(FAIL|Error|error)\b|●|Expected|Received|Exception/
const WARNING_PATTERN = /\bwarning\b\s+.*?\s([\w@/-]+)$/gi

function gradeOutput(rawText) {
  const blockingLines = []
  const warningCountByRule = new Map()

  for (const line of rawText.split('\n')) {
    if (BLOCKING_PATTERN.test(line)) {
      blockingLines.push(line)
      continue
    }
    WARNING_PATTERN.lastIndex = 0
    const match = line.match(WARNING_PATTERN)
    if (match) {
      const rule = match[1]
      warningCountByRule.set(rule, (warningCountByRule.get(rule) ?? 0) + 1)
    }
  }

  if (blockingLines.length === 0 && warningCountByRule.size === 0) {
    return '全部通过'
  }

  const warningSummary = [...warningCountByRule]
    .map(([rule, count]) => `${rule} ×${count}`)
    .join('，')

  return [
    '【阻塞级,必须先修】',
    ...blockingLines,
    '',
    `【警告级,报告即可,不用全改】${warningSummary || '无'}`,
  ].join('\n')
}

function readInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text || '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

const input = readInput()
const rawOutput = typeof input.tool_output === 'string' ? input.tool_output : ''
const graded = gradeOutput(rawOutput)

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    updatedOutput: graded,
  },
}))
