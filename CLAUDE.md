# GrassAgent 项目说明

极简 AI Agent 骨架。用来学习 Agent 的运行机制。

## 设计前提

**依赖策略**：核心逻辑（LLM 调用、SSE 解析、Agent 循环、工具执行）只用 Node 内置能力，不引运行时包。基础设施层允许少量成熟库，当前 6 个：`zod`（配置校验）、`pino`（结构化日志）、`p-retry`（退避重试）、`p-limit`（并发控制）、`@earendil-works/pi-schema`（工具参数校验）、`@earendil-works/pi-tui`（终端界面）。新增运行时依赖前先和用户确认。

**每个模块单一职责**，依赖方向单向向下，禁止循环依赖：

```
cli.ts → agent.ts → llm.ts → protocol.ts
   ↓        ↓                      ↑
  tui.ts   tools.ts           providers/
   ↓        ↓                (openai.ts)
config.ts  pathGuard.ts
   ↓
logger.ts / transport.ts / retry.ts / mutationQueue.ts
sessionStore.ts
```

`messages.ts` 是内部消息模型，provider 无关；`protocol.ts` 定义 provider 协议和注册表；`providers/` 下按厂商分文件。`config.ts` 独立：被 cli.ts 消费，不反向依赖任何模块。

`theme.ts` 只被 `tui.ts` 消费，配色相关的东西都在那。`nonInteractiveTerminal.ts` 实现 pi-tui 的 `Terminal` 接口，用于 stdin 不是 TTY 的环境。

## 环境

- Node >= 24，直接跑 TypeScript 不编译（type stripping 在 24.3+ 默认启用，不需要 `--experimental-strip-types` flag）
- 启动：`npm start`；类型检查：`npm run typecheck`；单元测试：`npm run test:unit`；端到端：`npm test`
- 配置走 `.env`，所有变量在 `src/config.ts` 的 schema 里集中定义，新增变量必须同时更新 schema 和 `.env.example`
- 系统提示词在 `src/cli.ts`，不在 `.env` 里

## 编码约定

- 注释讲「为什么这么写」，不重复代码字面意思，简短
- 变量用完整英文单词，不用缩写
- 工具是纯函数：`execute(args) => Promise<string>`，不持有 agent 状态，不在工具内部访问 context
- 复杂功能编码前先想设计模式：单一职责、开闭原则、依赖倒置、封装变化

## 业务逻辑兜底

写业务逻辑必须有兜底，触发兜底要记日志，日志带上关键调用信息。参考已有实现：

- `src/agent.ts` 上下文压缩失败时保留原始消息，不用空摘要替换
- `src/cli.ts` 会话文件逐行容错解析，坏行跳过而非丢弃全部历史
- `src/llm.ts` 请求失败时区分 abort 与真实错误，返回不同事件
- `src/transport.ts` 每次重试都新建超时控制器，超时信号不跨尝试污染

## 不能破坏的约束

改代码前先读这几条，都是踩过坑才留下的：

**1. 每个 tool_call 必须有对应 tool_result。** OpenAI 协议硬性要求。`run_bash` 被 abort 时跳过的工具，必须补 `error:aborted`。漏掉会导致下次恢复会话时 API 返回 400。

**2. max_tokens 截断时不要执行工具。** 参数 JSON 不完整，执行必然报错。正确做法是把错误信息塞回 context，让模型重发。

**3. 流结束时才发 tool_call。** 参数是增量拼接的 partial JSON，只能在 SSE 流结束后统一解析。不要在解析中途执行。

**4. abort 时丢弃已收集的 tool_calls。** 否则 assistant 消息带着 tool_use 却没有后续 tool_result。

**5. pino 的对象参数必须在第一个位置。** 写成 `logger.info('消息', {字段})` 会**静默丢掉字段**——这是 pino 的既定行为，不是 bug。正确写法 `logger.info({字段}, '消息')`。

**6. 路径沙箱必须在 resolve 之后判断，并且要解析符号链接。** `pathGuard.resolve` 先把路径展开成绝对路径，再比对是否落在工作区内。先判断后展开的话 `../` 能绕过边界。只做字符串判断也不够——工作区里的软链指向外部时会漏过去，所以最终判断要用 `realpath` 解析后的真实路径。

**7. 内部消息模型不能带 provider 语义。** `messages.ts` 里的 `ContentBlock` 是自有结构，不许出现 OpenAI 的 `tool_calls`/`tool_call_id` 之类字段。协议转换只发生在 `providers/` 下。这样加新 provider 不用改 agent 循环和上下文管理。

**8. provider 注册是有副作用的，要显式导入。** 内置 provider 在 `src/providers/index.ts` 里注册。需要内置 provider 的地方必须 `import './providers/index.ts'`，不能假设它一定被加载过。

**9. 工具参数必须先校验再执行。** `agent.ts` 在执行前调 `validateToolArguments`，校验失败不执行工具，把错误回填给 context 让模型重发。执行时要用校验后的参数（类型转换的结果要生效），不是原始参数。

**10. 会话用 SQLite 存，不自己管锁文件。** `src/sessionStore.ts` 用 Node 内置的 `node:sqlite`，WAL 模式 + `busy_timeout` 支持多进程并发读写。每个进程独立的 `sessionId`，会话互相隔离。不要再加锁文件机制——SQLite 已经处理了，而且锁文件方案会拒绝第二个实例，多会话共存更合理。

**11. `createPathGuard` 和 `builtinTools` 是异步的。** 它们要先 `realpath` 解析工作区的真实路径才能做沙箱判断。改动它们的调用方时要跟着 await。

**12. `node:sqlite` 的实验性警告要压掉。** 启动脚本用 `--disable-warning=ExperimentalWarning`（按类型精确静音，不影响其他警告），`src/sessionStore.ts` 里还有运行时兜底。**兜底必须拦 `process.emit` 而不是 `process.emitWarning`**——Node 派发警告走的是前者，只拦后者无效（实测过）。

**13. 用 `DatabaseSync` 而不是 `Database`。** `DatabaseSync` 在 Node 26.11 起是文档级弃用别名（DEP0210），但 `Database` 导出要到 v26.11 才有——当前 `@types/node` 也只有 `DatabaseSync`。所以现在只能用 `DatabaseSync`，等 Node 26.11 普及后再换。

**14. 修改文件的工具必须声明 `mutatesFiles`。** 并行执行时，声明了 `mutatesFiles: ['path']` 的工具会按文件真实路径排队（`src/mutationQueue.ts`），同一文件依次执行、不同文件并行。

没声明的工具默认自由并发。**「读-改-写」流程的工具（像 `edit`）必须声明**，否则两个并发 edit 同一文件会互相覆盖，丢更新。

**15. 工具结果的顺序必须和 tool_call 原始顺序一致。** 事件可以按完成顺序发，但写进 context 的结果顺序不能乱——API 要求每个 tool_call 有配对的 tool_result，顺序错了下次恢复会话会 400。

**16. 文件队列的 key 解析必须在注册队列内部。** `src/mutationQueue.ts` 里 `getMutationQueueKey` 要放进 `registrationQueue` 里面执行，不能在外面先 await。否则两个并发调用解析 key 的完成顺序不确定，同一文件的操作可能按 `[2, 1]` 而不是 `[1, 2]` 执行——模型说"先写 A 再改 A"时顺序就错了。

**17. 文件队列必须可重入。** 用 `AsyncLocalStorage` 跟踪当前执行链持有的 key。工具内部自己又包一层 `withFileMutationQueue` 是安全的，不会把自己等死（没有可重入支持时会静默挂住 agent）。

**18. 工具执行完必须检查 abort 再问模型。** 打断可能发生在工具跑着的时候。工具跑完把 `tool_result` 回填后，如果 `signal.aborted` 就直接结束回合——再发一次请求会被 abort 白跑一趟，而且重试逻辑不认 abort，会把打断后的失败当网络错误重试 3 次。

**19. 声明了 `mutatesFiles` 的工具必须锁住全部路径。** 只锁第一个路径的话，第二个文件上的并发写照样会互相覆盖。多路径时按路径排序后依次拿锁——所有工具用同一套排序，不会互相等死。

**20. `sequential: true` 的工具单独成段。** 它不该和同一轮里的其他工具并发跑，不管有没有声明 `mutatesFiles`。`src/agent.ts` 的 `splitIntoSegments` 把这类工具切成独立的段。

**21. 测试里模拟 abort 不要用计数器。** 并行执行下工具完成顺序不确定，`counter++` 之后判断 `=== 1` 可能永远不成立（另一个工具已经把计数加到 2 了），abort 根本触发不了，测的还是正常路径。用独立的标志位。

**22. 非交互模式的退出时机。** stdin 读完了（EOF）不代表能退出——那一行触发的回合可能还在跑。`src/cli.ts` 用 `roundRunning` 跟踪，回合结束才退。提前退出会把回合杀在半路上，工具可能执行了一半，会话也没存下来。

**23. 退出前要 flush 渲染。** pi-tui 的 `requestRender` 是 `process.nextTick` 里的异步调度，直接 `process.exit` 的话最后一帧还没画就被杀了，输出缺一截。退出前调 `tui.flush()`（内部是同步的 `renderNow`）。

**24. 非交互模式的输入要逐字符发。** pi-tui 的编辑器把输入当按键序列处理，不是当整行文本。一次发一整行的话 `decodePrintableKey` 只能取到第一个字符。回车要单独发——它是提交键，混在文本里会被当成插入换行。

**25. 非 TTY 时不要发 ANSI 控制序列。** 输出重定向到文件时它们就是乱码。`src/nonInteractiveTerminal.ts` 的 `writeControl` 在 `!process.stdout.isTTY` 时跳过。

**26. 上下文压缩只改「发给模型的视图」，不改历史。** `context.messages` 是完整历史（也是会话存储的内容），`context.compaction` 记录「前多少条已被摘要覆盖」。发给模型的是 `buildModelContext()` 拼出来的摘要 + 保留区。改历史会带来两个后果：切点可能劈开 tool_use/tool_result 导致 API 400；会话存储按条数切片，历史被砍之后新消息写不进去。

**27. 压缩的切点不能劈开工具调用和结果。** `findSafeBoundary` 遇到「保留区里有落单的 tool_result」就把切点往前挪。判据直接看结果本身，不用猜配对关系。

**28. 会话存储要能识别「历史被替换」。** `sync()` 按条数切片只写新增部分——但 `/clear` 和切换会话会换掉历史内容，这时切片就错了。`sessionStore.ts` 用 `persistedContents` 对账，发现历史被换过就删掉旧内容重写。

**29. 斜杠命令在本地执行，不发给模型。** 命令名拼错也要拦下来——否则会被当成普通输入发给模型。命令实现注入进 `SlashCommandRegistry`，TUI 只管显示。

**30. `ask_user` 的回答是 tool_result，不能再开一轮用户消息。** 它必须 `sequential: true`，独占输入。非交互模式下，回合进行中到达的整行要先入队，而且要在处理当前行的第一个 `await` 之前就占住输入——晚了的话管道里已经缓冲的下一行会冲进编辑器，回车被丢掉。EOF 时正在等的提问必须立刻结束，否则回合不收尾，进程也不退。

## 已知取舍

这些是刻意简化，不是 bug，改动前先想清楚影响：

- `run_bash` 用 shell 字符串拼接执行，有注入风险。工作目录已锁定在沙箱内，但命令内容不做参数化
- `edit` 工具的 `old_string` 未做大小写与空白归一化
- `edit` 工具一次只能改一处，要改多处用 `edit_batch`
- 上下文压缩后长对话的早期细节会丢失（只剩摘要）——历史还在库里，但模型看不到
- 工具参数用封闭对象（`additionalProperties: false`），模型多传字段会被拒绝
- 并行执行时 abort 语义变了：所有工具同时启动，abort 后已经在跑的工具不会停下（`error:aborted` 只补给还没开始的）
- 上下文压缩按消息条数判断，不是 token 数——消息长短差异大时压缩时机不准
- TUI 用主屏渲染（`TuiMainScreen`），不是备用屏——主屏保留终端的滚动历史，代价是不能自己管理滚动条
- markdown 排版在回合结束后才做，流式期间是纯文本
- 压缩状态存在内存里，不进数据库——重启后第一次回合会重新压缩一次

## 测试

单元测试用 Node 内置 `node:test`，放在 `test/`，不需要额外测试框架。端到端测试 `e2e-smoke.ts` 起本地 mock SSE 服务，不发真实 API 请求。

新增模块要在 `test/` 下补对应测试文件，文件名 `<模块名>.test.ts`。

## 会话存储

`~/.grassagent/sessions.db`，SQLite 库。`SessionStore` 负责读写，详见 `src/sessionStore.ts`。

`sync(messages)` 传的是**完整会话列表**，不是增量——内部按 `persistedCount` 切片只写新增部分。传增量会写不进去（切片后为空）。写入在一个事务里完成，中途失败会回滚，不会留下半截消息破坏配对关系。

历史被替换时（`/clear` 清空、切换会话换内容），`sync` 会用 `persistedContents` 对账，发现对不上就删掉旧内容重写——不然按条数切片会算错，新消息一条也写不进去。

多进程可以同时用同一个库文件（WAL 模式），各自的 `sessionId` 隔离。想接着上次的对话，把上次的 `sessionId` 传给 `GRASSAGENT_SESSION_ID`。

跨进程测试时，spawn 出来的子进程 stdin 必须保持打开（`stdio: ['pipe', ...]`）：stdin EOF 会让 readline 关闭、TUI 退出、进程提前结束。

## 斜杠命令

`/clear`、`/new`、`/sessions`、`/resume` 在本地执行，不发给模型。输入 `/` 会弹出命令补全列表（pi-tui 的 `CombinedAutocompleteProvider`）。

`/resume` 不带参数时弹会话选择器（`SelectList` + overlay），回车切换、Esc 取消。非交互模式没键盘，改成列出所有会话 ID 让人自己挑。

命令实现在 `src/cli.ts` 里注册，`src/slashCommands.ts` 只管解析和分发。

## 提交规范

Conventional Commits，中文描述：

```
<type>(<scope>): <subject>
```

type 取 feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert。
可以本地提交，推送必须经用户同意。禁用 `git checkout`，禁止任何破坏 git 历史的命令。
