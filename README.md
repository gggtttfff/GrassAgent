# GrassAgent

> 像小草一样生长 —— 微小却顽强。

一个用来学习「AI Agent 到底怎么跑起来」的骨架。你能读到一个 Agent 的每一块零件：SSE 流解析、工具调用、上下文压缩、会话持久化、配置校验、错误重试、路径沙箱。

不是框架，不打算替你做决定。它是你可以拆、可以改、可以往里长东西的原型。

## 特性

- **流式输出** —— 从 SSE chunk 里增量解析文本和 tool_call 参数
- **上下文自管理** —— 消息过多时让模型自己总结旧消息
- **可打断** —— Ctrl+C 中断当前回合，且不破坏 API 要求的 message 配对
- **会话持久化** —— SQLite 存历史，进程崩溃也不会丢
- **配置校验** —— 启动阶段就用 schema 校验环境变量，错误配置立刻报错
- **错误重试** —— 网络抖动 / 429 / 5xx 指数退避重试，4xx 业务错误立即失败
- **路径沙箱** —— 文件读写和命令执行都限制在工作区内
- **结构化日志** —— JSON 输出，密钥自动脱敏

## 目录结构

```
src/
  llm.ts         LLM 门面：按模型选 provider，转发调用
  protocol.ts    Provider 协议 + 注册表
  messages.ts    内部消息模型（provider 无关）
  providers/     按厂商分文件：openai.ts 等
  agent.ts       Agent 循环：流式调用 → 执行工具 → 结果回填 → 继续
  tools.ts       内置工具：read_file / write_file / edit / edit_batch / run_bash
  tui.ts         极简终端界面：单行输入 + 流式输出 + Ctrl+C
  cli.ts         拼装层：加载配置、恢复会话、把事件转发到 TUI
  config.ts      配置层：.env 解析 + schema 校验
  logger.ts      日志层：结构化 JSON 输出
  retry.ts       重试层：错误分类 + 指数退避 + 并发闸门
  transport.ts   传输层：超时 + 重试 + 并发控制
  pathGuard.ts   沙箱层：路径越界检测
  validation.ts  校验层：工具参数 JSON Schema 校验 + 类型转换
  mutationQueue.ts 变更队列：按文件串行化写操作
  sessionStore.ts 会话层：SQLite 存储（node:sqlite，零依赖）

test/            单元测试（node:test，无测试框架依赖）
e2e-smoke.ts     端到端测试：起本地 mock SSE 服务，覆盖 6 个场景 28 项断言
```

依赖方向单向向下，没有循环引用。想换掉任何一层，都不影响其他层。

### 分层要点

内部消息模型（`messages.ts`）不绑定任何厂商协议，只有在真正发请求的边界才转成 OpenAI/Anthropic 等格式。加一个新 provider = 实现 `Provider` 接口 + 注册，agent 循环和上下文管理一行都不用改。

## 环境要求

- Node.js >= 24（`node:sqlite` 需要 24+，type stripping 在 24.3+ 默认启用，不用编译）
- 一个 OpenAI 兼容的模型服务（OpenAI、DeepSeek、Ollama、vLLM 等均可）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 API
cp .env.example .env
# 然后编辑 .env 填入你自己的 key

# 3. 启动
npm start
```

启动后直接输入内容回车即可。模型回复过程中可以按 Ctrl+C 打断当前回合。

## 配置项

全部通过 `.env` 提供，也可以用系统环境变量覆盖（**系统环境变量优先级更高**）。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `GRASSAGENT_API_KEY` | API 密钥（必填） | 无 |
| `GRASSAGENT_MODEL` | 模型名称 | `gpt-4o-mini` |
| `GRASSAGENT_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `GRASSAGENT_WORKSPACE` | 工作区沙箱根目录 | 进程启动目录 |
| `GRASSAGENT_COMMAND_TIMEOUT_MS` | `run_bash` 超时（毫秒） | `3000` |
| `GRASSAGENT_MAX_TOKENS` | 单次生成上限 | `4096` |
| `GRASSAGENT_MAX_RETRIES` | 最大重试次数 | `3` |
| `GRASSAGENT_RETRY_BASE_DELAY_MS` | 退避起始毫秒 | `1000` |
| `GRASSAGENT_RETRY_MAX_DELAY_MS` | 退避上限毫秒 | `30000` |
| `GRASSAGENT_MAX_CONCURRENCY` | 并发请求上限 | `4` |
| `GRASSAGENT_REQUEST_TIMEOUT_MS` | 请求超时毫秒 | `120000` |
| `GRASSAGENT_LOG_LEVEL` | 日志级别 | `info` |
| `GRASSAGENT_LOG_FORMAT` | `json` 或 `pretty` | `json` |
| `GRASSAGENT_TOOL_EXECUTION` | `parallel` 或 `sequential` | `parallel` |
| `GRASSAGENT_SESSION_DATABASE_PATH` | 会话数据库路径 | `~/.grassagent/sessions.db` |
| `GRASSAGENT_SESSION_ID` | 会话 ID（留空则每次开新会话） | 自动生成 |

配置在启动阶段统一校验，非法值会直接报出是哪个变量、期望什么：

```
[grassagent] 配置校验失败:
  GRASSAGENT_MAX_TOKENS: MaxTokens 必须是整数
  GRASSAGENT_BASE_URL: API 地址必须是合法 URL
```

用本地模型（如 Ollama）时，把 `GRASSAGENT_BASE_URL` 指向 `http://localhost:11434/v1` 即可。

> `.env` 已被 `.gitignore` 忽略，不会进版本库。仓库里带的是 `.env.example`。

## 工作原理

一次完整的回合：

```
用户输入
  → agent.ts 组装 tools 定义
  → transport.ts 发流式请求（超时/重试/并发控制）
  → llm.ts 逐行解析 SSE
  → 边收边把文本增量推给 TUI 显示
  → 模型决定调工具 → tools.ts 执行（路径过沙箱）
  → 结果回填 context，再调一次模型
  → 模型不再调工具 → 回合结束，消息写入 sessions.db
```

几个刻意保留的细节，也是这个项目想讲清楚的东西：

**`max_tokens` 截断。** 输出被截断时 tool_call 的参数 JSON 是不完整的。这里不执行它，而是把错误塞回 context，让模型重新发一次。硬执行只会拿到半个 JSON。

**abort 后的配对补全。** API 要求每个 `tool_call` 都有对应的 `tool_result`。被 Ctrl+C 打断时跳过的工具，会补上 `error:aborted`，否则下次启动恢复会话时直接 400。

**上下文压缩。** 消息超过 50 条时，先让模型总结前 30 条，用摘要替换，保留最近 20 条。压缩失败则保留原样，不会用空摘要毁掉整个会话。

**容错读取会话。** 消息在 SQLite 里按序列号存，读出来逐条校验结构，坏行跳过而不是丢弃整个会话。写入在一个事务里完成，中途失败会回滚，不会留下半截消息破坏 tool_call / tool_result 的配对关系。

**参数 JSON 损坏的兜底。** tool_call 的参数是流式拼接的 JSON，可能因为截断或模型输出错误而无法解析。解析失败时不会当成空对象 `{}` 传给工具——那会让 `write_file` 拿到 `undefined` 路径乱写。而是标记为无效、跳过执行，把错误回填给模型让它重发。

**重试的边界。** 只有「还没拿到响应体」的失败才重试。网络错误、429、5xx 会指数退避重试；400/401/404 这类业务错误立即失败，不浪费等待时间。SSE 流一旦开始读 body 就不重试，否则会重复内容。

**路径沙箱。** 模型给的路径先 `resolve` 成绝对路径，再判断是否落在工作区内。必须 resolve 之后判断，否则 `../` 还没展开，边界判断会漏。越界时返回明确的错误文本，模型知道该改路径而不是反复重试。

符号链接也要拦：工作区里放一个指向外部的软链，路径字符串看着在界内，实际指向的却是界外的文件。所以判断前会用 `realpath` 解析真实路径，解析不到就逐级向上找到最近的已存在祖先（这样待创建的文件也能识破父目录里的软链）。工作区本身是软链时（macOS 的 `/tmp` 就是 `/private/tmp` 的软链）不会被误判。

**参数校验。** 工具参数是模型的输出，属于不可信输入。执行前用 JSON Schema 校验，失败就不执行工具，把错误回填给 context 让模型自己纠正后重发——和 `max_tokens` 截断、`argsInvalid` 是同一套处理机制。

校验开了宽松类型转换：模型传 `"42"` 当数字用会自动转成 `42`，传 `null` 当可选字段的省略也会被丢弃。只有转不了的（比如 `"abc"` 当数字）才算校验失败，不会为此多跑一轮。多余的字段会被拒绝（封闭对象），因为那通常是模型的幻觉。

**批量编辑的原子性。** `edit_batch` 一次改多处，两个语义值得留意。

一是**顺序应用**：每一项都在前一项的结果上替换。模型说「先把 A 改成 B，再把 B 改成 C」，结果和按顺序调两次 `edit` 一致——不是对着原文同时替换。

二是**原子性**：全部替换成功才写文件，中间任何一项失败则文件保持原样。半改完的文件比没改更糟——模型看不出哪些成功了，下一轮重试会重复应用已经生效的那几处。唯一性校验也跟着变严：每一项的 `old_string` 都必须在当前内容里唯一匹配，同一批里两次替换命中同一段文本会直接报错。

**provider 分层。** 内部消息模型不绑定任何厂商协议，只有在真正发请求的边界才转成 OpenAI/Anthropic 等格式。加一个新 provider = 实现 `Provider` 接口 + 注册，agent 循环一行都不用改。

**工具并发执行。** 一轮里多个 tool_call 会并发跑，不用排队等。模型要改三个文件时，三个写入同时进行。

但并发有个陷阱：`edit` 是「读-改-写」三步，两个并发 edit 同一文件会互相覆盖。所以工具可以声明自己会修改哪些文件（`mutatesFiles: ['path']`），这类操作按文件真实路径排队——同一文件依次执行，不同文件照常并行。`write_file` 和 `edit` 都做了声明。

队列是可重入的：工具内部自己再包一层也不会死等。同一文件的操作严格按调用顺序执行，模型说「先写 A 再改 A」就是这个顺序。

一个工具要改多个文件时，会按路径排序后依次拿锁——所有工具用同一套排序，不会出现两个工具互相等对方锁的死锁。

还有一种是工具压根不该并发：声明 `sequential: true`，它就会单独跑，不和同一轮里的其他工具抢跑。

结果事件的顺序始终和模型发出的顺序一致，不按完成顺序——UI 显示和模型意图能对上，排障时不用猜。

想退回串行：`GRASSAGENT_TOOL_EXECUTION=sequential`。

**会话存储。** 会话历史存在 SQLite 里（`~/.grassagent/sessions.db`），用的是 Node 内置的 `node:sqlite`，不引运行时依赖。

WAL 模式 + `busy_timeout`，多个进程可以同时读写同一个数据库文件。每个进程有独立的 `sessionId`，各存各的会话，互不干扰——允许多实例同时跑。

`node:sqlite` 目前是实验性 API，会打印 `ExperimentalWarning`。启动脚本已加 `--disable-warning=ExperimentalWarning` 精确静音这一类警告（其他警告不受影响），`src/sessionStore.ts` 里还有一层运行时兜底，直接跑 `node src/cli.ts` 也是干净的。

> 早期版本用 JSONL 文件存会话。升级后旧文件不会自动导入，需要的话可以自己写脚本转换。

## 测试

```bash
npm run test:unit    # 单元测试：config / pathGuard / retry / transport / tools / validation / provider / sessionStore / mutationQueue / parallelTools
npm test             # 端到端测试：本地 mock SSE 服务，不发真实 API 请求
npm run typecheck    # 类型检查
npm run test:all     # 上面三样一起跑
```

单元测试用 Node 内置的 `node:test`，不引入测试框架依赖。端到端测试起本地 mock 服务覆盖：

- 纯文本回合，无工具调用
- 工具调用闭环：调用 → 执行 → 结果回填 → 再次调用模型
- `max_tokens` 截断时不执行残缺参数
- 参数 JSON 损坏但 `finish_reason` 正常时同样拦下
- Ctrl+C 打断后每个 `tool_call` 都有配对 `tool_result`
- 消息超阈值后的上下文压缩

用本地 mock 而不是真实 API，测试才稳定可复现，也不消耗额度。

## 扩展

### 加一个新 provider

在 `src/providers/` 下新建文件，实现 `Provider` 接口——消息转换 + 流式解析：

```typescript
export const myProvider: Provider = {
  id: 'my-provider',
  // 是否支持这个 model。精确匹配的 provider 优先于兜底 provider
  matches: (model) => model.baseUrl?.includes('my-api.com') ?? false,
  async *stream(model, context, options) {
    // 把内部 Context 转成你家的协议格式,产出统一事件
    yield { type: 'text_delta', delta: '...' }
    yield { type: 'done', stopReason: 'end_turn' }
  },
}
```

然后在 `src/providers/index.ts` 里 `registerProvider(myProvider)`。

内部消息模型不会泄漏到协议层——转换只在你自己的 `stream` 里做。

### 加一个新工具

在 `src/tools.ts` 里写工厂函数接收 `PathGuard`：

```typescript
function buildMyTool(pathGuard: PathGuard): AgentTool {
  return {
    name: 'my_tool',
    description: '工具做什么，写给模型看的',
    parameters: { type: 'object', properties: { ... }, required: [...] },
    // 会修改文件的话声明一下,并发执行时同一文件的操作会排队
    mutatesFiles: ['path'],
    execute: async (args) => {
      // 涉及文件路径时用 pathGuard.resolve 限制在工作区内
      return '结果字符串'
    }
  }
}
```

然后加进 `builtinTools()` 的返回数组。工具是纯函数，不持有 agent 状态。

不声明 `mutatesFiles` 的工具可以自由并发。声明了但操作的是「读-改-写」流程的（像 `edit`），必须声明，否则并发时会丢更新。

工具压根不该并发（比如要独占某个资源），声明 `sequential: true`，它会单独跑，不和同一轮里的其他工具抢跑。

## License

[MIT](./LICENSE) © Pieory
