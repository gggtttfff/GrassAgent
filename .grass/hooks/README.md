# 钩子配方

两份可直接抄的示例。放在 `.grass/hooks/` 下,`hooks.json` 里引用它们。

## 验收钩子 `verify.mjs`

模型想停的时候自动跑检查,不过就让它再来一轮。

和「在规则文件里写请运行检查脚本」的区别是**跑不跑不再由模型决定**。
模型不再调工具时,Stop 钩子一定会被叫醒——这是唯一的硬关口。

关键点:

- `stop_hook_active` 告诉你本回合是不是已经被拉回过。**必须看它**,
  否则脚本会一直要求继续,把自己叫不醒。上限由 `maxStopContinuations` 兜底,
  但兜底触发时只给用户一句警告,不算正常收尾。
- `changed_files` 告诉你本轮改了什么。空的就直接放行——没改东西没什么可验收的。
- 拒绝用退出码 2,理由走 stderr。其它非 0 退出码按「钩子失败」处理:放行。

## 分级反馈钩子 `grade-feedback.mjs`

把工具输出按严重度分级,只在该出声的时候出声。

一次改动跑下来几十条 lint 警告加几个真错误,全量塞回上下文,
模型会来回横跳——修一个 lint 弄坏一个测试,最后忘了任务本身。

三级就够,再多模型还得花力气区分级别:

| 级别 | 内容 | 输出方式 |
|---|---|---|
| 阻塞级 | 编译失败、测试挂了、数据错了 | 完整输出,通常只有一两条 |
| 警告级 | lint 风格、字数偏差 | 按规则名汇总报个数 |
| 信息级 | 成功消息、普通日志 | 静默 |

**成功静默是第一原则。** 反馈一多就等于没反馈。

`updatedOutput` 会替换模型看到的内容。原文很长时,
要在改写结果里保留「全文在临时文件」那一行,不然模型就查不到原文了。

## 引用方式

`.grass/hooks.json`:

```json
{
  "Stop": [
    {
      "matcher": ".*",
      "hooks": [
        { "type": "command", "command": "node .grass/hooks/verify.mjs", "timeoutMs": 60000 }
      ]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "run_bash",
      "hooks": [
        { "type": "command", "command": "node .grass/hooks/grade-feedback.mjs", "timeoutMs": 5000 }
      ]
    }
  ]
}
```

`matcher` 匹配的是工具名(`PreToolUse` / `PostToolUse` / `PostToolUseFailure`)
或提示词(`UserPromptSubmit` / `Stop`),不是完整命令。

## PreToolUse 的路径解析

`PreToolUse` 的输入里带 `resolved_paths`,每个元素是:

```json
{ "requested": "src/a.ts", "real": "/abs/workspace/src/a.ts", "insideWorkspace": true }
```

`real` 是解析符号链接之后的真实路径。判断「不许写某个目录」要用 `real`——
只看 `requested` 的话,工作区里一个指向外部的软链就绕过去了。

`insideWorkspace` 为 false 表示路径越界(或者根本解析不了)。真实路径给不出时
`real` 会退回原始写法,但 `insideWorkspace=false` 已经够做判断。

只有声明了 `mutatesFiles` 的工具才有路径参数。远程沙盒里没有这个字段——
路径在另一台机器上,本机解析出来的结论是错的。
