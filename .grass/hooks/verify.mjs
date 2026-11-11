// 验收钩子示例 —— 模型想停的时候自动跑检查,不过就让它再来一轮。
//
// 放在 .grass/hooks.json 里:
// {
//   "Stop": [
//     { "matcher": ".*", "hooks": [{ "type": "command", "command": "node .grass/hooks/verify.mjs" }] }
//   ]
// }
//
// 它和「在 AGENTS.md 里写请运行检查脚本」的区别:
// 跑不跑不再由模型决定。模型不再调工具时,这个钩子一定会被叫醒。
//
// 输入(来自 stdin 的 JSON):
//   stop_hook_active  本回合是不是已经被拉回过。true 时要收手,
//                     否则会写成自己叫不醒自己的死循环。
//   changed_files     本回合写过的文件。空数组说明这轮什么都没改,
//                     没什么好验收的,直接放行。
//   prompt            模型最后说的那段话。
//
// 拒绝时退出码 2,理由走 stderr。
// 其它非 0 退出码按「钩子失败」处理:放行,不拦。

import { spawnSync } from 'node:child_process'

/** 最多追加几轮。超过就把人叫醒,不跟模型耗。 */
const MAX_EXTRA_ROUNDS = 3

/** 验收命令。换成你自己的。 */
const CHECK_COMMAND = 'npm test'

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

// 已经被拉回过,而且改过东西,那就给一次机会;再往下就交给人。
const alreadyContinued = input.stop_hook_active === true
const changedFiles = Array.isArray(input.changed_files) ? input.changed_files : []

if (alreadyContinued) {
  process.stderr.write(`已经追加过验收,不再追加(本轮改动:${changedFiles.length} 个文件)`)
  process.exit(2)
}

if (changedFiles.length === 0) {
  // 这轮没改任何文件,没什么可验收的。放行。
  process.exit(0)
}

const check = spawnSync(CHECK_COMMAND, {
  shell: true,
  encoding: 'utf8',
})

if (check.status === 0) {
  process.exit(0)
}

const report = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim()
process.stderr.write(
  `验收未通过(第 ${MAX_EXTRA_ROUNDS} 次机会内的第 1 次)。`
  + `请按下面的输出继续修,不要宣布完成:\n${report}`,
)
process.exit(2)
