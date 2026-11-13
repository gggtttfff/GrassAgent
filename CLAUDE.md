# GrassAgent 项目说明

极简 AI Agent 骨架。用来学习 Agent 的运行机制。

## 设计前提

**依赖策略**：核心逻辑（LLM 调用、SSE 解析、Agent 循环、工具执行）只用 Node 内置能力，不引运行时包。基础设施层允许少量成熟库，当前 6 个：`zod`（配置校验）、`pino`（结构化日志）、`p-retry`（退避重试）、`p-limit`（并发控制）、`@earendil-works/pi-schema`（工具参数校验）、`@earendil-works/pi-tui`（终端界面）。新增运行时依赖前先和用户确认。

**每个模块单一职责**，依赖方向单向向下，禁止循环依赖：

```
cli.ts                  唯一入口：拼装所有簇，自己不被任何模块引用
  ↓
ui/         tui / theme / sessionPicker / nonInteractiveTerminal / lineQueue / slashCommands
  ↓
agent/      agent / tools / askUser / hooks / hookConfig / dangerousCommands / approval / monitor
  ↓
llm/        llm / protocol / messages / compaction / completeText / modelRoster / providers/
instructions/ projectInstructions / skills
session/    sessionStore / sessionBundle / sessionTitle
sandbox/    daemon / docker·inProcess·ssh 后端 / 控制面 / remoteWorld
  ↓
world/      executionWorld / localWorld / outputBound / approvalGate / modeSwitch
  ↓
core/       logger / jsonSafety / retry / transport / validation /
            mutationQueue / pathGuard / textEdit / frontmatter
  ↓
config.ts / version.ts   叶子：只被引用，不引用任何模块
```

同一层的簇之间只有一条边：`session → llm`（会话要读写内部消息模型）。`remoteWorld` 留在 `sandbox/` 而不是 `world/`——它 import `sandbox/lexicalPath` 和 `sandbox/protocol`，挪过去就是 `world ↔ sandbox` 双向依赖。

`llm/messages.ts` 是内部消息模型，provider 无关；`llm/protocol.ts` 定义 provider 协议和注册表；`llm/providers/` 下按厂商分文件。`config.ts` 独立：被 cli.ts 消费，不反向依赖任何模块。`core/jsonSafety.ts` 只做 JSON 深度检查，被会话、规则、钩子和 provider 使用，不反向依赖它们。

`core/frontmatter.ts` 只解析 `---` 包起来的头（标量、列表、`>` / `|` 块标量），被规则扫描和技能扫描共用。

`instructions/projectInstructions.ts` 管规则和提示词，`instructions/skills.ts` 管技能包（`SKILL.md`）：前者整篇塞进系统提示词或列索引，后者只列名字和描述，正文由 `load_skill` 按需取。两边都不读用户主目录。技能从「执行世界」里读，本地和远程走同一套扫描逻辑。

`ui/theme.ts` 只被 `ui/tui.ts` 消费，配色相关的东西都在那。`ui/nonInteractiveTerminal.ts` 实现 pi-tui 的 `Terminal` 接口，用于 stdin 不是 TTY 的环境。

## 环境

- Node >= 24，直接跑 TypeScript 不编译（type stripping 在 24.3+ 默认启用，不需要 `--experimental-strip-types` flag）
- 启动：`npm start`；类型检查：`npm run typecheck`；单元测试：`npm run test:unit`；端到端：`npm test`
- 配置走 `.env`，所有变量在 `src/config.ts` 的 schema 里集中定义，新增变量必须同时更新 schema 和 `.env.example`
- 宿主目录用系统环境变量 `GRASSAGENT_HOME` 配置（默认 `~/.grassagent`），规则集中在 `src/core/homeDirectory.ts`；`.env`、会话库、插件信任记录、云端会话、技能评估卡都跟着它
- `.env` 的位置必须先于它的内容定下来，所以**只有系统环境变量**里的 `GRASSAGENT_HOME` 能改变 `.env` 的位置；写在 `.env` 里的只影响派生的数据路径。宿主目录下没有 `.env` 时回退项目根目录并记 warn 日志
- 系统提示词在 `src/cli.ts`，不在 `.env` 里

## 编码约定

- 注释讲「为什么这么写」，不重复代码字面意思，简短
- 变量用完整英文单词，不用缩写
- 工具是纯函数：`execute(args) => Promise<string>`，不持有 agent 状态，不在工具内部访问 context
- 复杂功能编码前先想设计模式：单一职责、开闭原则、依赖倒置、封装变化

## 业务逻辑兜底

写业务逻辑必须有兜底，触发兜底要记日志，日志带上关键调用信息。参考已有实现：

- `src/agent/agent.ts` 上下文压缩失败时保留原始消息，不用空摘要替换
- `src/cli.ts` 会话文件逐行容错解析，坏行跳过而非丢弃全部历史
- `src/llm/llm.ts` 请求失败时区分 abort 与真实错误，返回不同事件
- `src/core/transport.ts` 每次重试都新建超时控制器，超时信号不跨尝试污染

## 不能破坏的约束

改代码前先读这几条，都是踩过坑才留下的：

**1. 每个 tool_call 必须有对应 tool_result。** OpenAI 协议硬性要求。`run_bash` 被 abort 时跳过的工具，必须补 `error:aborted`。漏掉会导致下次恢复会话时 API 返回 400。

**2. max_tokens 截断时不要执行工具。** 参数 JSON 不完整，执行必然报错。正确做法是把错误信息塞回 context，让模型重发。

**3. 流结束时才发 tool_call。** 参数是增量拼接的 partial JSON，只能在 SSE 流结束后统一解析。不要在解析中途执行。

**4. abort 时丢弃已收集的 tool_calls。** 否则 assistant 消息带着 tool_use 却没有后续 tool_result。

**5. pino 的对象参数必须在第一个位置。** 写成 `logger.info('消息', {字段})` 会**静默丢掉字段**——这是 pino 的既定行为，不是 bug。正确写法 `logger.info({字段}, '消息')`。

**6. 路径沙箱必须在 resolve 之后判断，并且要解析符号链接。** `pathGuard.resolve` 先把路径展开成绝对路径，再比对是否落在工作区内。先判断后展开的话 `../` 能绕过边界。只做字符串判断也不够——工作区里的软链指向外部时会漏过去，所以最终判断要用 `realpath` 解析后的真实路径。

**7. 内部消息模型不能带 provider 语义。** `messages.ts` 里的 `ContentBlock` 是自有结构，不许出现 OpenAI 的 `tool_calls`/`tool_call_id` 之类字段。协议转换只发生在 `providers/` 下。这样加新 provider 不用改 agent 循环和上下文管理。

**8. provider 注册是有副作用的，要显式导入。** 内置 provider 在 `src/llm/providers/index.ts` 里注册。需要内置 provider 的地方必须 `import './providers/index.ts'`，不能假设它一定被加载过。

**9. 工具参数必须先校验再执行。** `agent.ts` 在执行前调 `validateToolArguments`，校验失败不执行工具，把错误回填给 context 让模型重发。执行时要用校验后的参数（类型转换的结果要生效），不是原始参数。

**10. 会话用 SQLite 存，不自己管锁文件。** `src/session/sessionStore.ts` 用 Node 内置的 `node:sqlite`，WAL 模式 + `busy_timeout` 支持多进程并发读写。每个进程独立的 `sessionId`，会话互相隔离。不要再加锁文件机制——SQLite 已经处理了，而且锁文件方案会拒绝第二个实例，多会话共存更合理。

**11. `createPathGuard` 和 `builtinTools` 是异步的。** 它们要先 `realpath` 解析工作区的真实路径才能做沙箱判断。改动它们的调用方时要跟着 await。

**12. `node:sqlite` 的实验性警告要压掉。** 启动脚本用 `--disable-warning=ExperimentalWarning`（按类型精确静音，不影响其他警告），`src/session/sessionStore.ts` 里还有运行时兜底。**兜底必须拦 `process.emit` 而不是 `process.emitWarning`**——Node 派发警告走的是前者，只拦后者无效（实测过）。

**13. 用 `DatabaseSync` 而不是 `Database`。** `DatabaseSync` 在 Node 26.11 起是文档级弃用别名（DEP0210），但 `Database` 导出要到 v26.11 才有——当前 `@types/node` 也只有 `DatabaseSync`。所以现在只能用 `DatabaseSync`，等 Node 26.11 普及后再换。

**14. 修改文件的工具必须声明 `mutatesFiles`。** 并行执行时，声明了 `mutatesFiles: ['path']` 的工具会按文件真实路径排队（`src/core/mutationQueue.ts`），同一文件依次执行、不同文件并行。

没声明的工具默认自由并发。**「读-改-写」流程的工具（像 `edit`）必须声明**，否则两个并发 edit 同一文件会互相覆盖，丢更新。

**15. 工具结果的顺序必须和 tool_call 原始顺序一致。** 事件可以按完成顺序发，但写进 context 的结果顺序不能乱——API 要求每个 tool_call 有配对的 tool_result，顺序错了下次恢复会话会 400。

**16. 文件队列的 key 解析必须在注册队列内部。** `src/core/mutationQueue.ts` 里 `getMutationQueueKey` 要放进 `registrationQueue` 里面执行，不能在外面先 await。否则两个并发调用解析 key 的完成顺序不确定，同一文件的操作可能按 `[2, 1]` 而不是 `[1, 2]` 执行——模型说"先写 A 再改 A"时顺序就错了。

**17. 文件队列必须可重入。** 用 `AsyncLocalStorage` 跟踪当前执行链持有的 key。工具内部自己又包一层 `withFileMutationQueue` 是安全的，不会把自己等死（没有可重入支持时会静默挂住 agent）。

**18. 工具执行完必须检查 abort 再问模型。** 打断可能发生在工具跑着的时候。工具跑完把 `tool_result` 回填后，如果 `signal.aborted` 就直接结束回合——再发一次请求会被 abort 白跑一趟，而且重试逻辑不认 abort，会把打断后的失败当网络错误重试 3 次。

**19. 声明了 `mutatesFiles` 的工具必须锁住全部路径。** 只锁第一个路径的话，第二个文件上的并发写照样会互相覆盖。多路径时按路径排序后依次拿锁——所有工具用同一套排序，不会互相等死。

**20. `sequential: true` 的工具单独成段。** 它不该和同一轮里的其他工具并发跑，不管有没有声明 `mutatesFiles`。`src/agent/agent.ts` 的 `splitIntoSegments` 把这类工具切成独立的段。

**21. 测试里模拟 abort 不要用计数器。** 并行执行下工具完成顺序不确定，`counter++` 之后判断 `=== 1` 可能永远不成立（另一个工具已经把计数加到 2 了），abort 根本触发不了，测的还是正常路径。用独立的标志位。

**22. 非交互模式的退出时机。** stdin 读完了（EOF）不代表能退出——那一行触发的回合可能还在跑。`src/cli.ts` 用 `roundRunning` 跟踪，回合结束才退。提前退出会把回合杀在半路上，工具可能执行了一半，会话也没存下来。

**23. 退出前要 flush 渲染。** pi-tui 的 `requestRender` 是 `process.nextTick` 里的异步调度，直接 `process.exit` 的话最后一帧还没画就被杀了，输出缺一截。退出前调 `tui.flush()`（内部是同步的 `renderNow`）。

**24. 非交互模式的输入要逐字符发。** pi-tui 的编辑器把输入当按键序列处理，不是当整行文本。一次发一整行的话 `decodePrintableKey` 只能取到第一个字符。回车要单独发——它是提交键，混在文本里会被当成插入换行。

**25. 非 TTY 时不要发 ANSI 控制序列。** 输出重定向到文件时它们就是乱码。`src/ui/nonInteractiveTerminal.ts` 的 `writeControl` 在 `!process.stdout.isTTY` 时跳过。

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

**49. 技能正文不进系统提示词，只有名字和描述进。** 一个技能动辄几百行（Cursor 官方的 `create-skill` 有 508 行），每轮都塞会挤掉对话。模型判断任务和描述对得上时调 `load_skill` 取全文，正文提到的脚本、模板再用 `read_file` 读。没被点名、描述也对不上的不要加载。

**50. 技能和附件都必须在工作区内。** `skills.ts` 和规则扫描共用同一个 `pathGuard`，软链指到工作区外直接跳过。技能根是工作区相对的（`.grass/skills`、`.cursor/skills` 等），不要加 `~/.cursor/skills-cursor` 这类用户主目录——那要给沙箱开只读口子，是另一个决定。

**51. 没有描述的技能不要索引。** 描述是模型判断「什么时候该用」的唯一依据，缺了它这条索引只会占上下文。正文里有一级标题时可以拿标题补，两样都没有就跳过并记日志。

**52. 技能要从执行世界里读，不要直接用 `node:fs`。** 远程世界的技能文件在沙盒里，本机 `fs` 读到的是另一份（甚至根本没有）。`SkillFileSystem` 有两个实现：`createLocalSkillFiles`（fs + pathGuard）和 `createWorldSkillFiles`（world.list + world.readRaw）。

**53. 读技能正文必须走 `readRaw`。** 普通 `read` 超过 200 行只返回尾部，SKILL.md 动辄几百行，用它会把正文读坏，而且症状是「内容少了一半」，很难排查。

**54. `load_skill` 必须先过审批。** 技能正文是仓库里的文本，拿到它就等于让模型按别人的指令做事。`GRASSAGENT_APPROVE_SKILLS` 取 ask/allow/deny，默认 ask；没人能回答时按拒绝处理。它是 `sequential: true`——审批要独占输入通道。

**55. 重新扫描技能要同时换三样东西。** 工具里的 `load_skill`、系统提示词里的技能段、只读技能的命令注册。只换其中一样，模型看到的和能调到的就对不上。重建系统提示词时规则段要单独存着，否则一次 reload 就把项目规则丢光。

**56. 测试里 spawn CLI 必须显式关掉远程世界。** `runCliWithInput` 的 cwd 是仓库根，配置层会读到开发机的 `.env`；那里如果配了 `GRASSAGENT_EXECUTION_WORLD=remote`，测试就会去连真实沙盒，技能扫描也会读到远程目录。所有 CLI 测试都要带 `GRASSAGENT_EXECUTION_WORLD=local`。

**57. 沙盒模式只有一个写入路径：`ExecutionWorld.setMode`。** 命令和快捷键都走 `src/world/modeSwitch.ts`，不要在别处直接改 `world.policy.mode`。远程世界的模式由 daemon 判定，改本地字段不等于切成功——必须等 RPC 确认。

**58. daemon 的模式要存成共享的可变引用。** `startDaemon` 里 `modeRef = { current }`，每个请求的 `HandlerContext` 指向同一个对象。直接捕获字符串的话，`setMode` 改了也没有任何请求看得到——因为 `HandlerContext` 是每个请求新建的字面量。

**59. 远程全权限模式要两侧都改。** 客户端 `advertisedPath` 会先拒掉区外路径，daemon 的 `advertisedFromLocal` 又会把区外路径写成越界错误——后者发生在写盘之后，会出现「写成功却报失败」。客户端走 `advertisedPathLoose`，daemon 走 `displayPath`，两处都要覆盖 read / write / edit 三条路。

**60. 危险命令规则读本机工作区，不读沙盒。** 沙盒里的文件模型能改，规则得是用户这台机器上的配置，位置和 `.grass/hooks.json` 一致。规则在 `run_bash` 内部、钩子改写参数之后匹配——提前到 agent 的预检阶段会被 `PreToolUse` 钩子绕过。

**61. 系统提示词分段存，用 `rebuildSystemPrompt()` 重建。** 规则段、技能段、模式段、钩子上下文各自一份。任何一段变了都走这个函数，不然一次 `/skills reload` 就把模式段和钩子上下文冲掉。

**62. 升级到全权限要人点头，配置写死不算。** `.env` 里写 `danger-full-access` 是用户本人授权，启动时用 `createStartupEscalationGate()` 放行并记 warn 日志；会话里用 `/mode` 切过去走 `askEscalation`，每次都问、不缓存。审批门按 `action.kind` 分支——`GRASSAGENT_APPROVE_SKILLS=allow` 只管技能，不该顺带放行升级。

**63. Shift+Tab 只在只读和可写之间循环。** 升级到全权限要走 `/mode`：回合中途弹审批会跟 `ask_user` 抢同一个 `editor.onSubmit`。`/mode` 执行期间要 `tui.setBusy(true)`，否则空闲状态下的 Ctrl+C 会直接退进程。

**64. Stop 钩子要给「拉回标记」和「本轮改了什么」。** 钩子拿不到这两样就写不出能收手的验收脚本：`stop_hook_active` 告诉它本回合是不是已经被拉回过（不看这个会写成自己叫不醒自己的死循环），`changed_files` 告诉它这轮改了什么（空的就没什么可验收的）。`maxStopContinuations` 只是兜底，触发时只给用户一句警告，不算正常收尾。

**65. Stop 钩子的 `additionalContext` 在没有拒绝时没人会读。** 回合到此为止，那段上下文没有落点。丢掉它必须记日志，否则用户以为钩子生效了。别的钩子事件（`PreToolUse` / `PostToolUse`）的 `additionalContext` 是接进上下文的，别混。

**66. PreToolUse 钩子拿到的路径参数必须已经解析过符号链接。** 钩子要拦「不许写某个目录」，自己写 resolve + realpath 很容易漏掉软链那一层。工作区根由 `runAgent` 的 `workspaceRoot` 传进来，解析失败时 `insideWorkspace` 给 false。远程世界没有这个字段——路径在另一台机器上，本机解析出来的结论是错的。

**67. 压缩的摘要里要留「验证记录」。** 丢掉的只能是过程，不能是依据：什么检查跑过、什么失败了、为什么失败，丢了就没法接着干。`SUMMARY_FORMAT` 里这一节不能省。

**68. `/compact` 只改发给模型的视图，不动历史。** 和自动压缩同一套 `compactContext`，只是 `force: true` 跳过阈值判断，参数拼进摘要提示词引导重点。`context.messages` 始终是完整历史，会话存储和 `/resume` 恢复出来的都是全的。

**69. 提示模板命令不走本地命令表。** `.grass/prompts/*.md` 每份变成一条斜杠命令，但执行等价于「把展开后的正文当成一条用户消息发给模型」——这样钩子、会话存储、回合计数都不用另外接一遍。模板命令不进 `SlashCommandRegistry`，命令名和内置命令冲突时不注册（内置优先）。

**70. 示例配置不要放在默认生效路径上。** `.grass/hooks.json` 是默认读取路径，把它放在那里等于默认启用——CLI 测试的 cwd 就是仓库根，会读到它，钩子脚本一跑就把测试搞挂。示例放 `.grass/hooks/hooks.example.json`，让用户自己拷过去。

**71. 三类模型不要串岗。** 标题和压缩摘要走小模型，对话和工具循环走主力模型，写文件和命令的放行走审批模型。什么时候压缩由 token 预算决定，不由小模型再否决一次。审批失败、抛错或结果无法解析时拒绝执行，不要默许。`world/approvalGate.ts` 管的是人要不要点头，和审批模型不是同一条路。

**72. 监视器报告只能作为 user 消息进上下文。** 产生它的那次工具调用早就返回了，伪造成 `tool_result` 会破坏配对关系（约束 1）。所以带 `[monitor]` 标记当一条用户消息塞回去，由 `pumpMonitorReports` 单独开一轮。

**73. 后台报告要排队，不能插进正在跑的回合。** `pumpMonitorReports` 见到 `roundRunning` 就先退出，队列里的报告等这一轮结束再送。用户输入处理完之后还要主动 `pumpMonitorReports()` 兜一次——报告是在回合中途到的，那时 pump 早退，没人会再触发它。

**74. 监视器必须随会话结束清理。** `shutdown()` 和 stdin EOF 两条退出路径都要 `monitors.cancelAll()`：清定时器、杀掉后台命令。漏了的话 Ctrl+C 之后还有命令在跑，而且定时器会一直把进程吊住。

**75. 后台命令的输出只留尾部。** 前台命令结束时才交给模型，可以留全文；后台是一直在跑的，`BACKGROUND_TAIL_CHARS`（8 KB）封顶，报告里再截到 2 KB。不封顶的话一条刷屏命令能把进程撑爆。

**76. 远程世界没有后台执行能力，要明确报错。** `ExecutionWorld.execBackground` 是可选的，远程沙盒协议还没有增量输出和杀进程。`monitor` 工具遇到时返回「不支持后台执行」并提示改用 `run_bash`，不能假装能用——硬模拟只能把整条命令阻塞跑完，那就不是监视器了。`timer` 和 `sandbox` 两种在远程下照常可用。

## 已知取舍

这些是刻意简化，不是 bug，改动前先想清楚影响：

- 技能是启动时扫进内存的快照，会话中途改 `SKILL.md` 要 `/skills reload` 或重启才生效（想看最新内容可以直接 `read_file`）
- 同名技能（不分大小写）会全部禁用并在启动时告警，只记日志不自动挑选
- 技能正文超过 24000 字会被截断，`load_skill` 会给出标题清单，让模型用 `read_file` 读缺的段落
- 批量加载一次最多 8 个技能、合计 48000 字
- 扫描缓存写在 `.grass/tmp/skills-cache.json`，只按大小和修改时间判断失效；缓存被改坏就当没有缓存
- 远程世界不用缓存，每次会话的沙盒都是新的
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
- danger-full-access 在 Docker 后端下只放开 Grass 的路径闸门——容器根文件系统仍是 `--read-only`、仍是非 root，实际能写的只有 `/workspace` 和 `/tmp`；SSH 后端下才是整台远程机。同名模式在两种后端能力不同，不能对外暗示「全权限 = 宿主全权限」
- 危险命令规则匹配的是模型给的 `bash -c` 字符串，`bash script.sh`、`find -delete`、引号换行都能绕开。它是护栏不是边界
- 危险命令规则启动时读一次即固定，不热加载——否则模型能在可写模式下改写规则文件削弱后面的拦截
- 远程挂回（`GRASSAGENT_SANDBOX_ID`）时以本次配置的模式为准，会影响同一个沙盒上的其他挂回者
- 沙盒协议版本 2→3 不兼容，外部独立控制面（`npm run sandbox:control`）必须和客户端一起升级
- 远程 daemon 启动瞬间是 workspace-write，配置的模式在创建后用一次 `setMode` 对齐。此时还没有任何工具调用，没有窗口期
- 监视器不活在会话之外：Ctrl+C 或 stdin 读完就全部取消，后台命令一起杀掉。所以非交互模式下管道一关就看不到定时报告
- 远程沙盒只支持 `timer` 和 `sandbox` 两种监视，`command` 要等沙盒协议支持增量输出和杀进程
- 后台命令不参与 `mutatesFiles` 排队，它跑起来之后什么时候写文件是它自己的事
- 监视器报告滚出上下文之后不会再回来；追加轮次也不会重发

## 测试

单元测试用 Node 内置 `node:test`，放在 `test/`，不需要额外测试框架。端到端测试 `e2e-smoke.ts` 起本地 mock SSE 服务，不发真实 API 请求。

新增模块要在 `test/` 下补对应测试文件，文件名 `<模块名>.test.ts`，子目录和 `src/` 保持一致（`test/core/`、`test/llm/` ……）。

测试文件比仓库根深了一层，用 `../src/` 引用源码的地方要写成 `../../src/<簇>/`。`test/cli/nonInteractiveCli.test.ts` 和 `test/core/version.test.ts` 里的 `projectRoot` 也要多退一层。

## 会话存储

`<GRASSAGENT_HOME>/sessions.db`（默认 `~/.grassagent/sessions.db`），SQLite 库。`SessionStore` 负责读写，详见 `src/session/sessionStore.ts`。

`sync(messages)` 传的是**完整会话列表**，不是增量——内部按 `persistedCount` 切片只写新增部分。传增量会写不进去（切片后为空）。写入在一个事务里完成，中途失败会回滚，不会留下半截消息破坏配对关系。

历史被替换时（`/clear` 清空、切换会话换内容），`sync` 会用 `persistedContents` 对账，发现对不上就删掉旧内容重写——不然按条数切片会算错，新消息一条也写不进去。

多进程可以同时用同一个库文件（WAL 模式），各自的 `sessionId` 隔离。想接着上次的对话，把上次的 `sessionId` 传给 `GRASSAGENT_SESSION_ID`。

跨进程测试时，spawn 出来的子进程 stdin 必须保持打开（`stdio: ['pipe', ...]`）：stdin EOF 会让 readline 关闭、TUI 退出、进程提前结束。

## 斜杠命令

`/clear`、`/new`、`/sessions`、`/resume`、`/export`、`/import`、`/instructions`、`/compact`、`/mode` 在本地执行，不发给模型。输入 `/` 会弹出命令补全列表（pi-tui 的 `CombinedAutocompleteProvider`）。

`/export` 把会话收成 `grassagent-bundle` JSON。默认写到工作区 `.grass/grassagent-bundle.json`，这个文件已在 `.gitignore` 里。`/import` 默认同 ID 跳过，`--replace` 覆盖。`/instructions` 只列出路径和生效方式，不把提示词再打印一遍。

`/resume` 不带参数时弹会话选择器（`SelectList` + overlay），回车切换、Esc 取消。非交互模式没键盘，改成列出所有会话 ID 让人自己挑。

`/compact` 手动压缩上下文，参数是摘要要重点保留的内容（如 `/compact 保留验证记录`）。只改发给模型的视图，历史不动。

`/mode` 看当前沙盒模式或切换它，升级到全权限要过审批。

命令实现在 `src/cli.ts` 里注册，`src/ui/slashCommands.ts` 只管解析和分发。

## 提示模板

工作区 `.grass/prompts/*.md` 每份变成一条斜杠命令。frontmatter 取 `description` 和 `argument-hint`，正文里的 `$ARGUMENTS` 换成全部参数、`$1`..`$9` 换成单个参数。

执行等价于「把展开后的正文当成一条用户消息发给模型」，和手打进去完全一样——钩子、会话存储、回合计数都不用另外接。模板命令不进 `SlashCommandRegistry`，只进补全列表。命令名和内置命令冲突时跳过，内置优先。

`src/instructions/prompts.ts` 负责扫描、解析、展开和匹配。

## 提交规范

Conventional Commits，中文描述：

```
<type>(<scope>): <subject>
```

type 取 feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert。
可以本地提交，推送必须经用户同意。禁用 `git checkout`，禁止任何破坏 git 历史的命令。
