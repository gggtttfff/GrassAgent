# GrassAgent

> 像小草一样生长 —— 微小却顽强。

一个用来学习「AI Agent 到底怎么跑起来」的骨架。你能读到一个 Agent 的每一块零件：SSE 流解析、工具调用、上下文压缩、会话持久化、配置校验、错误重试、路径沙箱。

不是框架，不打算替你做决定。它是你可以拆、可以改、可以往里长东西的原型。

## 特性

- **流式输出** —— 从 SSE chunk 里增量解析文本和 tool_call 参数
- **上下文自管理** —— 消息过多时让模型自己总结旧消息
- **可打断** —— Ctrl+C 中断当前回合，且不破坏 API 要求的 message 配对
- **会话持久化** —— 追加式 JSONL，进程崩溃也不会丢历史
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
  tools.ts       内置工具：read_file / write_file / edit / run_bash
  tui.ts         极简终端界面：单行输入 + 流式输出 + Ctrl+C
  cli.ts         拼装层：加载配置、恢复会话、把事件转发到 TUI
  config.ts      配置层：.env 解析 + schema 校验
  logger.ts      日志层：结构化 JSON 输出
  retry.ts       重试层：错误分类 + 指数退避 + 并发闸门
  transport.ts   传输层：超时 + 重试 + 并发控制
  pathGuard.ts   沙箱层：路径越界检测
  validation.ts  校验层：工具参数 JSON Schema 校验 + 类型转换
  session.ts     会话层：JSONL 存储 + 文件轮转 + 并发写保护

test/            单元测试（node:test，无测试框架依赖）
e2e-smoke.ts     端到端测试：起本地 mock SSE 服务，覆盖 6 个场景 27 项断言
```

依赖方向单向向下，没有循环引用。想换掉任何一层，都不影响其他层。

### 分层要点

内部消息模型（`messages.ts`）不绑定任何厂商协议，只有在真正发请求的边界才转成 OpenAI/Anthropic 等格式。加一个新 provider = 实现 `Provider` 接口 + 注册，agent 循环和上下文管理一行都不用改。

## 环境要求

- Node.js >= 22.6（需要 `--experimental-strip-types` 直接跑 TypeScript，无需编译）
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
| `GRASSAGENT_SESSION_FILE` | 会话文件路径 | `~/.grassagent/session.jsonl` |
| `GRASSAGENT_SESSION_MAX_FILE_BYTES` | 会话文件轮转阈值（字节） | `5242880` |
| `GRASSAGENT_SESSION_MAX_BACKUP_FILES` | 保留几个备份文件 | `5` |

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
  → 模型不再调工具 → 回合结束，消息追加到 session.jsonl
```

几个刻意保留的细节，也是这个项目想讲清楚的东西：

**`max_tokens` 截断。** 输出被截断时 tool_call 的参数 JSON 是不完整的。这里不执行它，而是把错误塞回 context，让模型重新发一次。硬执行只会拿到半个 JSON。

**abort 后的配对补全。** API 要求每个 `tool_call` 都有对应的 `tool_result`。被 Ctrl+C 打断时跳过的工具，会补上 `error:aborted`，否则下次启动恢复会话时直接 400。

**上下文压缩。** 消息超过 50 条时，先让模型总结前 30 条，用摘要替换，保留最近 20 条。压缩失败则保留原样，不会用空摘要毁掉整个会话。

**容错读取会话。** `session.jsonl` 是逐行解析的，坏行跳过而不是整个文件丢弃。进程崩溃可能写出半行 JSON，逐行容错才能保住剩下的历史。

**参数 JSON 损坏的兜底。** tool_call 的参数是流式拼接的 JSON，可能因为截断或模型输出错误而无法解析。解析失败时不会当成空对象 `{}` 传给工具——那会让 `write_file` 拿到 `undefined` 路径乱写。而是标记为无效、跳过执行，把错误回填给模型让它重发。

**重试的边界。** 只有「还没拿到响应体」的失败才重试。网络错误、429、5xx 会指数退避重试；400/401/404 这类业务错误立即失败，不浪费等待时间。SSE 流一旦开始读 body 就不重试，否则会重复内容。

**路径沙箱。** 模型给的路径先 `resolve` 成绝对路径，再判断是否落在工作区内。必须 resolve 之后判断，否则 `../` 还没展开，边界判断会漏。越界时返回明确的错误文本，模型知道该改路径而不是反复重试。

符号链接也要拦：工作区里放一个指向外部的软链，路径字符串看着在界内，实际指向的却是界外的文件。所以判断前会用 `realpath` 解析真实路径，解析不到就逐级向上找到最近的已存在祖先（这样待创建的文件也能识破父目录里的软链）。工作区本身是软链时（macOS 的 `/tmp` 就是 `/private/tmp` 的软链）不会被误判。

**参数校验。** 工具参数是模型的输出，属于不可信输入。执行前用 JSON Schema 校验，失败就不执行工具，把错误回填给 context 让模型自己纠正后重发——和 `max_tokens` 截断、`argsInvalid` 是同一套处理机制。

校验开了宽松类型转换：模型传 `"42"` 当数字用会自动转成 `42`，传 `null` 当可选字段的省略也会被丢弃。只有转不了的（比如 `"abc"` 当数字）才算校验失败，不会为此多跑一轮。多余的字段会被拒绝（封闭对象），因为那通常是模型的幻觉。

**provider 分层。** 内部消息模型不绑定任何厂商协议，只有在真正发请求的边界才转成 OpenAI/Anthropic 等格式。加一个新 provider = 实现 `Provider` 接口 + 注册，agent 循环一行都不用改。

**会话文件的轮转和并发保护。** 会话是追加式 JSONL，跑久了会无限增长，所以超过阈值（默认 5MB）就滚动成 `session.1.jsonl`、`session.2.jsonl`……启动时按时间顺序把备份和当前文件拼起来，历史不会丢。

并发保护用的是**会话所有权**（锁文件），不是只保护单次写。只锁单次写能防住文件行交错，但防不住语义交错——两个进程往同一个对话交替写消息，上下文会互相污染。所以第二个实例启动时会直接被拒绝并提示。持锁进程崩溃留下的残留锁会被自动接管（检查 pid 是否还活着）。想同时跑多个实例，用 `GRASSAGENT_SESSION_FILE` 给它们指定不同的会话文件。

## 测试

```bash
npm run test:unit    # 单元测试：config / pathGuard / retry / transport / tools / validation / provider
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
    execute: async (args) => {
      // 涉及文件路径时用 pathGuard.resolve 限制在工作区内
      return '结果字符串'
    }
  }
}
```

然后加进 `builtinTools()` 的返回数组。工具是纯函数，不持有 agent 状态。

## License

[MIT](./LICENSE) © Pieory
