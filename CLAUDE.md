# GrassAgent 项目说明

极简 AI Agent 骨架。用来学习 Agent 的运行机制。

## 设计前提

**依赖策略**：核心逻辑（LLM 调用、SSE 解析、Agent 循环、工具执行）只用 Node 内置能力，不引运行时包。基础设施层允许少量成熟库，当前 5 个：`zod`（配置校验）、`pino`（结构化日志）、`p-retry`（退避重试）、`p-limit`（并发控制）、`@earendil-works/pi-schema`（工具参数校验）。新增运行时依赖前先和用户确认。

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

## 已知取舍

这些是刻意简化，不是 bug，改动前先想清楚影响：

- `run_bash` 用 shell 字符串拼接执行，有注入风险。工作目录已锁定在沙箱内，但命令内容不做参数化
- `edit` 工具的 `old_string` 未做大小写与空白归一化
- `edit` 工具一次只能改一处，改多处要调多次（pi 支持一次传 `edits[]`）
- 上下文压缩只保留最近 20 条，长对话的早期细节会丢失
- TUI 是单行输入，不做 diff 渲染、组件树、markdown 渲染
- 工具参数用封闭对象（`additionalProperties: false`），模型多传字段会被拒绝
- 并行执行时 abort 语义变了：所有工具同时启动，abort 后已经在跑的工具不会停下（`error:aborted` 只补给还没开始的）

## 测试

单元测试用 Node 内置 `node:test`，放在 `test/`，不需要额外测试框架。端到端测试 `e2e-smoke.ts` 起本地 mock SSE 服务，不发真实 API 请求。

新增模块要在 `test/` 下补对应测试文件，文件名 `<模块名>.test.ts`。

## 会话存储

`~/.grassagent/sessions.db`，SQLite 库。`SessionStore` 负责读写，详见 `src/sessionStore.ts`。

`sync(messages)` 传的是**完整会话列表**，不是增量——内部按 `persistedCount` 切片只写新增部分。传增量会写不进去（切片后为空）。写入在一个事务里完成，中途失败会回滚，不会留下半截消息破坏配对关系。

多进程可以同时用同一个库文件（WAL 模式），各自的 `sessionId` 隔离。想接着上次的对话，把上次的 `sessionId` 传给 `GRASSAGENT_SESSION_ID`。

跨进程测试时，spawn 出来的子进程 stdin 必须保持打开（`stdio: ['pipe', ...]`）：stdin EOF 会让 readline 关闭、TUI 退出、进程提前结束。

## 提交规范

Conventional Commits，中文描述：

```
<type>(<scope>): <subject>
```

type 取 feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert。
可以本地提交，推送必须经用户同意。禁用 `git checkout`，禁止任何破坏 git 历史的命令。
