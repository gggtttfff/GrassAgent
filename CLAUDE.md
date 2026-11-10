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
   ↓          hooks.ts
logger.ts / transport.ts / retry.ts / mutationQueue.ts
sessionStore.ts
hookConfig.ts → hooks.ts
projectInstructions.ts → pathGuard.ts
sessionBundle.ts → messages.ts
jsonSafety.ts
```

`messages.ts` 是内部消息模型，provider 无关；`protocol.ts` 定义 provider 协议和注册表；`providers/` 下按厂商分文件。`config.ts` 独立：被 cli.ts 消费，不反向依赖任何模块。`jsonSafety.ts` 只做 JSON 深度检查，被会话、规则、钩子和 provider 使用，不反向依赖它们。

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

**30. 钩子失败默认放行。** 退出码不是 0 也不是 2、超时、JSON 写坏，都只记日志，不拦截。想拒绝必须退出码 2，或 JSON 里 `decision: "block"` / `permissionDecision: "deny"`。把所有非 0 退出码都当成拒绝的话，一个写错的脚本会把会话卡死。

**31. 钩子不能拆掉 tool_call / tool_result 配对。** `PreToolUse` 拒绝、或钩子跑到一半被 Ctrl+C 打断，没执行的工具也要补 `tool_result`（拒绝理由或 `error:aborted`）。漏了下次恢复会话会 400。

**32. `updatedInput` 必须再过一遍参数校验。** 钩子改写的参数和模型给的参数一样不可信。校验失败就不执行，把错误回填给模型。

**33. 工具钩子按 tool_call 的原始顺序串行跑。** `PreToolUse` 在执行之前，`PostToolUse` / `PostToolUseFailure` 在工具跑完之后。不要把钩子放进并行段里——改写结果和审计日志都依赖这个顺序。被 `PreToolUse` 拒绝的调用不再发 `PostToolUseFailure`。

**34. Stop 钩子拉回回合有上限。** 默认 5 次（`maxStopContinuations`）。一个总是拒绝的脚本不能让回合永远问模型。

**35. SessionEnd 不能挂在 `process` 的 `exit` 事件上。** 那个回调里不能 await。钩子走显式退出路径（Ctrl+C、stdin 结束、SIGINT），`exit` 事件只做同步的终端和数据库清理。

**36. 打断之后不要再启动新钩子。** 已经在跑的命令要杀掉。`PreCompact` 只在这一轮确实要压缩时才跑，不要每轮空转。

**37. `ask_user` 的回答是 tool_result，不能再开一轮用户消息。** 它必须 `sequential: true`，独占输入。非交互模式下，回合进行中到达的整行要先入队，而且要在处理当前行的第一个 `await` 之前就占住输入——晚了的话管道里已经缓冲的下一行会冲进编辑器，回车被丢掉。EOF 时正在等的提问必须立刻结束，否则回合不收尾，进程也不退。

**38. 导入的会话包只当数据。** 不执行包里的文本，不写钩子，不把 API Key 放进包。`tool_call` / `tool_result` 配不上对就整段拒绝，否则下次请求 400。同 ID 默认跳过，只有 `--replace` 才覆盖。

**39. 识别其他工具的规则失败不能挡住启动。** 单个文件读失败、JSON 坏了、软链越界，都跳过并记日志。远程 URL 不抓取。工作区外的路径不读。`node_modules` 和 `.git` 不扫。

**40. 提示词和按文件生效的规则不要整篇塞进系统提示词。** 只有「始终生效」的规则进系统提示词，单文件 12000 字、合计 24000 字封顶。其余列成索引，让模型用 `read_file` 按需读。提示词没被点名、也和描述对不上时不要执行。

**41. 导出会话前先 sync，导入覆盖当前会话后立刻 load。** 不 sync，最后一轮还在内存里，带走的是旧对话。导入之后再拿旧的 `context.messages` 去 sync，会对账失败，把刚导进来的内容盖掉。

**42. 不可信 JSON 先量深度再解析。** `JSON.parse` 能吃下几万层嵌套，但之后的 `JSON.stringify`（落盘、导出、压缩、发给模型）是递归的，大约几千层就会把调用栈打穿。文本和对象都在固定栈上检查，超过 256 层直接拒绝，字符串里的括号不算。规则发现和坏的会话行仍然跳过；会话包、钩子文件把原因交给用户。

**43. SSH 隧道必须是透明 TCP 转发，不能解析内容。** daemon 说的是 HTTP。中间包一层 JSON 信封再塞进通道，daemon 根本不认识，会一直等到超时。`openSshTunnel` 用 `node:net` 起 TCP 服务，`socket.pipe(channel).pipe(socket)` 直通，让字节原样过去。

**44. 往远程部署走 SFTP，不走 shell 重定向。** `cat > file` 要等通道关闭才收尾，而 ssh2 的服务端 Session 通道在 `CHANNEL_CLOSE` 时不推 EOF（`lib/utils.js` 里 `channel.server && constructor.name === 'Session'` 直接 return），靠它会永远挂着。目录用 SFTP `mkdir`、文件用 `writeFile`、权限用 `chmod`，语义清楚也不依赖对端 shell 语法。

**45. 控制面的创建和挂回必须校验调用方令牌。** `POST /v1/sandboxes` 和 `/attach` 拿不到沙盒自己的令牌（挂回时还没有沙盒），所以靠 `controlToken` 挡。不挡的话，知道 `sandboxId` 的人就能挂回别人的沙盒——attach 会重新签发沙盒令牌。控制面只监听回环时不配也能用，暴露到网络前必须配。

**46. 远程命令的输出要等 close，不能靠 exit 收尾。** `exit-status` 只带退出码，收到它时 stdout 可能还没到齐；直接用它会拿到空字符串。`runRemote` 用 `exit` 记退出码、`close` 收尾，再加超时兜底。

**47. 远程 daemon 的端口交给系统分配，不要写死。** 写死的话同一台远程机上两个 Grass 会话必然抢端口，后来者起不来、老的还在应答，症状是「令牌被拒绝」。用 `--port 0` 启动，再从 `daemon.log` 里读回 `daemon listening http://127.0.0.1:PORT`。

**48. 部署全程复用一条 SFTP 会话。** 每个操作单开会话要重复握手，11 个文件加建目录实测 40 秒；一条会话降到 14 秒。建目录用 `pathLevels` 逐级建并记住建过的层。

## 已知取舍

这些是刻意简化，不是 bug，改动前先想清楚影响：

- `run_bash` 用 shell 字符串拼接执行，有注入风险。工作目录已锁定在沙箱内，但命令内容不做参数化
- `edit` 工具的 `old_string` 未做大小写与空白归一化
- `edit` 工具一次只能改一处，要改多处用 `edit_batch`
- 上下文压缩后长对话的早期细节会丢失（只剩摘要）——历史还在库里，但模型看不到
- 工具参数用封闭对象（`additionalProperties: false`），模型多传字段会被拒绝
- 并行执行时 abort 语义变了：所有工具同时启动，abort 后已经在跑的工具不会停下（`error:aborted` 只补给还没开始的）
- 上下文压缩的 token 用字符数 / 4 估算，不是模型真实用量。中文和代码的实际密度会偏，只用来决定何时压、留多少
- TUI 用主屏渲染（`TuiMainScreen`），不是备用屏——主屏保留终端的滚动历史，代价是不能自己管理滚动条
- markdown 排版在回合结束后才做，流式期间是纯文本
- 压缩状态存在内存里，不进数据库——重启后第一次回合会重新压缩一次
- 钩子只有命令和进程内函数两种。没有 HTTP / prompt / agent 钩子，也不支持 async
- 命令钩子用 shell 执行。命令来自用户自己的配置文件，不是模型输出；模型给的参数只走 stdin 的 JSON
- 界面上先打印的 tool_call 仍是模型原始参数。钩子改写成功时，写进历史的是实际执行的那份
- SSH 后端不支持挂回（`attach` 返回 null）：远程目录跟着 daemon 一起删了，没有可留下的卷
- SSH 后端要求远程有 Node 24.3+（daemon 靠 type stripping 直接跑 `.ts`），不给远程装任何第三方依赖
- SSH 后端的远程工作区路径来自配置，不自动创建。路径不存在时 daemon 起不来
- Stop 钩子默认最多把一个回合拉回 5 次
- 按文件生效的规则不会在读到匹配文件时自动注入，只在系统提示词里留索引
- 不读用户主目录里的全局规则，也不抓取 opencode 配置里的远程 URL
- 会话包是明文 JSON，对话里如果曾经出现过密钥，导出时不会再扫一遍剔掉

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

`/clear`、`/new`、`/sessions`、`/resume`、`/export`、`/import`、`/instructions` 在本地执行，不发给模型。输入 `/` 会弹出命令补全列表（pi-tui 的 `CombinedAutocompleteProvider`）。

`/export` 把会话收成 `grassagent-bundle` JSON。默认写到工作区 `.grass/grassagent-bundle.json`，这个文件已在 `.gitignore` 里。`/import` 默认同 ID 跳过，`--replace` 覆盖。`/instructions` 只列出路径和生效方式，不把提示词再打印一遍。

`/resume` 不带参数时弹会话选择器（`SelectList` + overlay），回车切换、Esc 取消。非交互模式没键盘，改成列出所有会话 ID 让人自己挑。

命令实现在 `src/cli.ts` 里注册，`src/slashCommands.ts` 只管解析和分发。

## 提交规范

Conventional Commits，中文描述：

```
<type>(<scope>): <subject>
```

type 取 feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert。
可以本地提交，推送必须经用户同意。禁用 `git checkout`，禁止任何破坏 git 历史的命令。
