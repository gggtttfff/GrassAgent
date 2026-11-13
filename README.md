# GrassAgent

> 像小草一样生长 —— 微小却顽强。

一个用来学习「AI Agent 到底怎么跑起来」的骨架。你能读到一个 Agent 的每一块零件：固定的回合循环、SSE 流解析、工具调用、上下文压缩、会话持久化、配置校验、错误重试，以及一块可替换的执行世界。

不是框架，不打算替你做决定。回合循环是固定的 `runAgent`，插件换不掉它。它是你可以拆、可以改、可以往里长东西的原型。

## 特性

- **流式输出** —— 从 SSE chunk 里增量解析文本和 tool_call 参数
- **终端界面** —— 差分渲染 + markdown 排版，流式输出不闪屏
- **斜杠命令** —— `/clear` `/new` `/sessions` `/resume` `/export` `/import` `/instructions` `/cloud`，本地执行，带命令补全
- **想来就来，想走就走** —— 会话导出成一个 JSON 包，换一台机器再导回来。包里没有 API Key
- **认得仓库里已有的约定** —— 启动时识别 opencode、cursor、claude、kiro 的规则和提示词。始终生效的规则进上下文，提示词只列目录，点名再用
- **上下文自管理** —— 消息过多时让模型自己总结旧消息，历史本身不丢
- **可打断** —— Ctrl+C 中断当前回合，且不破坏 API 要求的 message 配对
- **向用户提问** —— 模型调用 `ask_user` 后停下等你回答，答完再继续
- **会话持久化** —— SQLite 存历史，进程崩溃也不会丢
- **配置校验** —— 启动阶段就用 schema 校验环境变量，错误配置立刻报错
- **错误重试** —— 网络抖动 / 429 / 5xx 指数退避重试，4xx 业务错误立即失败
- **执行世界** —— 文件和命令走同一块 `ExecutionWorld`。远程创建失败不退回本机。模型循环留在 Grass 进程里，daemon 只做文件和命令
- **进程内插件** —— 工具、世界、会话命令、provider、规则和技能在进程内登记。工作区 `.grass/plugins` 要先信任，不能申请 `host.exec`，也不加载可执行入口
- **云端会话** —— 一个会话一块沙盒。`ask_user` 只在面对用户的会话上；云端要人决定时把短状态交回来
- **路径沙箱** —— 本地世界里，文件读写和命令执行都限制在工作区内
- **生命周期钩子** —— 会话、提示词、工具和压缩前后可以观察、拒绝或改写
- **监视器** —— 后台跑命令或定时回看状态，报告在回合结束后还能推回模型
- **结构化日志** —— JSON 输出，密钥自动脱敏

## 目录结构

```
src/
  cli.ts         拼装层：加载配置、恢复会话、把事件转发到 TUI
  config.ts      配置层：.env 解析 + schema 校验
  version.ts     版本号：只从 package.json 读

  core/          零业务语义的底层，被谁都能用
    logger.ts        日志层：结构化 JSON 输出
    jsonSafety.ts    不可信 JSON 的深度护栏
    retry.ts         重试层：错误分类 + 指数退避 + 并发闸门
    transport.ts     传输层：超时 + 重试 + 并发控制
    validation.ts    校验层：工具参数 JSON Schema 校验 + 类型转换
    mutationQueue.ts 变更队列：按文件串行化写操作
    pathGuard.ts     沙箱层：路径越界检测
    textEdit.ts      唯一替换的唯一实现，本地世界和 daemon 共用
    frontmatter.ts   YAML 头解析：标量 / 列表 / 块标量

  llm/           模型侧
    llm.ts       LLM 门面：按模型选 provider，转发调用
    protocol.ts  Provider 协议 + 注册表
    messages.ts  内部消息模型（provider 无关）
    compaction.ts 压缩层：决定发给模型看哪一段，不改历史
    completeText.ts 不带工具的一次性文本补全
    modelRoster.ts 三个模型角色：小模型 / 主力模型 / 审批模型
    providers/   按厂商分文件：openai.ts 等

  agent/         回合循环与工具
    agent.ts     Agent 循环：流式调用 → 执行工具 → 结果回填 → 继续
    tools.ts     内置工具：read_file / write_file / edit / edit_batch / run_bash / monitor
    monitor.ts   监视器：后台命令、定时报告、沙盒状态，报告推回上下文
    approval.ts  审批模型判断写文件和命令能不能执行
    askUser.ts   向用户提问。工具本身不碰终端，怎么问由调用方注入
    hooks.ts     钩子运行时：命令 / 函数、拒绝、改写、超时
    hookConfig.ts 钩子配置：读取并校验 hooks.json

  world/         执行世界
    executionWorld.ts 文件读写和命令执行的统一接口
    localWorld.ts     本机实现：pathGuard + 子进程
    outputBound.ts    大文件和长命令只把尾部交给模型
    approvalGate.ts   要不要人点头

  session/       会话持久化
    sessionStore.ts   SQLite 存储（node:sqlite，零依赖）
    sessionBundle.ts  会话包：把 SQLite 里的对话收成 JSON，再导回来
    sessionTitle.ts   小模型生成会话标题

  ui/            终端界面
    tui.ts          组件树 + 差分渲染 + markdown 排版
    theme.ts        配色：markdown / 编辑器 / 列表
    sessionPicker.ts 会话选择器：列表 + 弹窗
    nonInteractiveTerminal.ts 管道输入时的终端实现
    lineQueue.ts    非交互输入队列：回合进行中到达的整行先留住
    slashCommands.ts 斜杠命令：解析 + 分发

  instructions/  仓库里已有的约定
    projectInstructions.ts 识别 opencode / cursor / claude / kiro 的规则和提示词
    skills.ts      SKILL.md：只列名字描述，正文由 load_skill 按需取
    prompts.ts    .grass/prompts/*.md：每份变成一条斜杠命令

  plugin/        进程内插件。不替换 runAgent
    host.ts            清单注册表：工具、命令、provider 同名即失败
    contract.ts        能力闭集。世界平面不能申请宿主能力
    workspacePlugins.ts  .grass/plugins 信任后才登记清单
    worldPlugins.ts    按配置打开 local 或 remote，失败不改绑
    sessionCommands.ts 内置斜杠命令
    promptPlugins.ts   规则和技能发现
    cloudSession.ts    云端会话：一会话一沙盒，短状态写在宿主目录
    builtinProviders.ts 核对清单里的 provider 已经显式注册

  sandbox/       沙箱后端与控制面
    daemon.ts      跑在沙盒里的窄服务
    control*.ts    控制面：生命周期、HTTP 服务、命令行入口
    *Backend.ts    docker / in-process / ssh 三种后端
    ssh*.ts        SSH 连接、主机密钥校验、隧道、远程部署
    openWorld.ts   按配置打开执行世界
    remoteWorld.ts 走窄协议连控制面的远程世界

test/            单元测试（node:test，无测试框架依赖），子目录与 src 一一对应
e2e-smoke.ts     端到端测试：起本地 mock SSE 服务，覆盖 6 个场景 31 项断言
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

### 斜杠命令

输入 `/` 会弹出命令补全列表，回车执行。命令在本地执行，不会发给模型。

| 命令 | 说明 |
| --- | --- |
| `/clear` | 清空当前对话，保留会话 |
| `/new` | 开一个新会话 |
| `/sessions` | 列出所有会话 |
| `/resume` | 切换到别的会话 |
| `/export` | 把会话导出成文件。不带路径时写到 `.grass/grassagent-bundle.json` |
| `/import` | 从文件导回会话。同 ID 默认跳过，`--replace` 才覆盖 |
| `/instructions` | 列出识别到的规则和提示词 |
| `/compact` | 手动压缩上下文。参数是摘要要重点保留的内容 |
| `/mode` | 查看或切换沙盒权限模式 |
| `/cloud` | 面对用户的会话里，把任务排进云端会话。`/cloud status <会话ID>` 查看，需要人决定时代为提问 |

`/resume` 不带参数时会弹出会话选择器，上下移动、回车切换、Esc 取消。

`/compact` 只改发给模型的那份内容，完整历史不动——会话存储里保存的还是全部消息。

### 沙盒权限模式

文件和命令能碰到多大范围，由沙盒权限模式决定。

| 模式 | 文件 | 命令 |
| --- | --- | --- |
| `read-only` | 只能读工作区 | 整个拒绝执行命令 |
| `workspace-write` | 可读写工作区 | 工作目录锁在工作区内 |
| `danger-full-access` | 绕过工作区限制 | 不锁工作目录 |

默认 `workspace-write`。三种方式切换：

- **配置**：`GRASSAGENT_SANDBOX_MODE` 决定启动时的模式
- **命令**：`/mode` 看当前模式，`/mode read-only` 切一个
- **快捷键**：交互模式按 Shift+Tab 在 `read-only` 和 `workspace-write` 之间循环

输入框上方有一行状态，随时能看到当前模式。切模式立刻生效——模型的下一次工具调用就按新模式来，不用重开会话。

切到 `danger-full-access` 会绕过工作区边界，所以要人点头：`.env` 里写死它算你本人授权，启动时直接生效并记一条警告日志；会话里用 `/mode` 切过去会弹一次审批，输入 `y` 才同意。非交互模式（管道、CI）没人能点头，按拒绝处理。

远程沙盒也支持切换。模式由沙盒里的 daemon 判定，切换会真的通知到它。

> `danger-full-access` 在 Docker 后端下只是放开 Grass 的路径闸门——容器根文件系统仍是只读的、仍是非 root，实际能写的只有 `/workspace` 和 `/tmp`。SSH 后端下才是整台远程机。同名模式在两种后端能力不同，别把「全权限」理解成「宿主全权限」。

### 执行世界

文件和命令读同一块根，接口是 `ExecutionWorld`。`runAgent` 只看见工具返回的字符串。

| `GRASSAGENT_EXECUTION_WORLD` | 行为 |
| --- | --- |
| `local`（默认） | 本机工作区。路径先 resolve 再 realpath |
| `remote` | 控制面上的沙盒（Docker、SSH，或本进程里的 daemon）。创建失败就退出，不改绑本机 |

daemon 只做文件和命令。模型循环留在 Grass 进程里，不进容器，也不进远程 daemon。上面的权限模式决定这块世界能碰到多大范围。控制面地址、镜像、SSH 和限额在 `.env.example`，名字以 `GRASSAGENT_SANDBOX_` 开头。

### 插件

插件在进程内登记清单，不替换 `runAgent`。启动时按固定顺序注册内置插件，名字冲突就起不来。

| 插件 | 贡献 |
| --- | --- |
| `grass.tools.files` | `read_file` / `write_file` / `edit` / `edit_batch` / `run_bash` |
| `grass.tools.monitor` | `monitor` |
| `grass.tools.skills` | `load_skill` |
| `grass.tools.ask-user` | `ask_user`。只在面对用户的会话里 |
| `grass.tools.handoff` | `handoff_user`。只在云端会话里，用来代替 `ask_user` |
| `grass.session.commands` | 内置斜杠命令 |
| `grass.world.local` / `grass.world.remote` | 按配置打开其中一个。失败不改试另一个 |
| `grass.llm.openai` | OpenAI 兼容 provider。协议转换仍在 `src/llm/providers/` |
| `grass.instructions` | 规则和技能发现 |

实际注册出来的工具名必须和清单一致，多一个或少一个都是组装错误。没有技能时不注册 `load_skill`，清单里仍留着这个名字。

工作区 `.grass/plugins/<目录>/grass-plugin.json` 默认不生效。`GRASSAGENT_TRUST_PLUGINS`：

| 值 | 行为 |
| --- | --- |
| `ask`（默认） | 交互模式下问一次，回答 yes 才登记，并记到 `~/.grassagent/plugin-trust.json`。这份记录必须在工作区外面，指到工作区里会被忽略。非交互没人点头，按不信任跳过 |
| `allow` | 直接登记 |
| `deny` | 一律跳过 |

即使信任了，工作区清单也必须是世界平面，不能申请 `host.exec`。登记的只是清单，不加载可执行入口。某一份写坏了就跳过它，不挡启动。

`GRASSAGENT_SKILL_EVAL` 默认关。打开后才登记技能评估，而且不进模型工具表。

### 云端会话

默认 `GRASSAGENT_SESSION_PROFILE=facing`，这是面对用户的会话，带 `ask_user`。

`/cloud 任务描述` 只在宿主目录 `~/.grassagent/cloud-sessions` 里排队，不在当前进程里开沙盒。接着另开一个进程，带上排队时打印的会话 ID，并使用远程执行世界：

```bash
GRASSAGENT_SESSION_PROFILE=cloud
GRASSAGENT_SESSION_ID=<排队时打印的 ID>
GRASSAGENT_EXECUTION_WORLD=remote
```

这个进程必须拿到自己的 `sandboxId`。没有沙盒就退出，不改绑本机。一块沙盒只能绑一个会话，一个会话也不能再绑第二块；已经被占用就关掉刚打开的世界并退出。

云端档没有 `ask_user`。要人决定时调用 `handoff_user`，把一段短状态写回宿主目录。面对用户的会话用 `/cloud status <会话ID>` 查看；状态是 `needs_user` 时在这边提问，回答记在同一份记录里。记录不在工作区里，沙盒里的工具写不到它。

模型循环仍是这个进程里的 `runAgent`，不进 daemon。

### 危险命令规则

`.grass/dangerous-commands.json` 里可以列几条不该跑的命令。文件不存在就等于没有规则，行为不变。

```json
{
  "commands": [
    { "pattern": "\\brm\\s+-[a-zA-Z]*r", "reason": "禁止递归删除" },
    { "pattern": "mkfs", "reason": "禁止格式化磁盘" }
  ]
}
```

`pattern` 是正则，匹配模型给的命令字符串，命中就拒绝执行并告诉模型原因。所有模式都生效——模式决定能碰到多大范围，规则决定哪些命令根本不跑。

规则文件读的是**本机工作区**下的那一份，不是沙盒里的：沙盒里的文件模型能改，规则得是你这台机器上的配置。文件存在但写坏了会在启动时报错，不会静默当成没有规则。

> 这是护栏，不是安全边界。匹配的是命令字符串本身，`bash script.sh`、`find -delete` 这类写法绕得开。真正的隔离靠沙盒和容器。

### 导入导出

会话存在本机的 SQLite 里。换机器、换目录之前，把对话收成一个文件带走：

```bash
/export
/export ~/backups/grass.json
/export ~/backups/one.json --session <会话ID>
/import ~/backups/grass.json
/import ~/backups/grass.json --replace
```

文件是 `grassagent-bundle` 版本 1 的 JSON。里面只有会话 ID、时间和消息。API Key 留在原来的 `.env`，钩子留在项目的 `.grass/hooks.json`。导入只把消息写进会话库，不执行包里的文字。

`tool_call` 和 `tool_result` 配不上对的会话会被拒绝，避免导进来之后下次请求直接 400。同 ID 已经存在时默认跳过，免得把这台机器上还在用的对话盖掉。嵌套超过 256 层的 JSON 会在解析前拒绝，避免一份极深的工具参数在保存或下一次请求时把进程打穿。

相对路径锚定工作区，`~` 展开到用户主目录。这是用户自己的命令，所以允许把文件写到工作区外面。

### 项目里已有的规则和提示词

启动时扫描工作区，认出这些文件：

| 工具 | 规则 | 提示词 |
| --- | --- | --- |
| opencode | `AGENTS.md`，以及 `opencode.json` / `opencode.jsonc` 里 `instructions` 指向的本地文件 | `.opencode/commands/`、`.opencode/agents/`，还有配置里的 `command` / `agents` |
| cursor | `.cursor/rules/**/*.mdc`、根目录 `.cursorrules`、`AGENTS.md` | `.cursor/commands/` |
| claude | `CLAUDE.md`、`CLAUDE.local.md`、`.claude/CLAUDE.md`、`.claude/rules/` | `.claude/commands/`、`.claude/agents/`、`.claude/output-styles/` |
| kiro | `.kiro/steering/`、`AGENTS.md` | `.kiro/agents/` |

始终生效的规则（例如根目录 `AGENTS.md`、`alwaysApply: true`、没有 `paths` 的 Claude 规则、Kiro `inclusion: always`）会放进系统提示词。按文件匹配、按描述判断、点名才用的规则只留一行索引，模型改到相关文件时用 `read_file` 再读。提示词同样只进索引：用户点名，或任务和描述对上时才读正文，不会当成当前任务自动执行。

单份规则超过 12000 字，或始终生效的规则合计超过 24000 字，就不再整篇塞进上下文，索引里会写明原因。

不抓取配置里的 `https://` 地址，不读工作区外面的文件。指向区外的软链会跳过。`node_modules`、`.git` 这类目录不扫描。某个文件坏了，或者 JSON 嵌套过深，只记日志，启动继续。不想要这套识别时设 `GRASSAGENT_LOAD_PROJECT_INSTRUCTIONS=0`。

用户主目录里的全局规则（`~/.claude`、`~/.config/opencode`、`~/.kiro`）不在这次的扫描范围里，它们不属于当前项目。

### 技能

`.grass/skills/`、`.cursor/skills/`、`.claude/skills/`、`.kiro/skills/`、`.opencode/skills/` 下的 `SKILL.md` 按技能处理。名字冲突（不分大小写）时**全部禁用**并在启动时告警，不替你挑。

技能正文不进系统提示词，只列名字、来源和描述。模型判断任务和某条描述对得上时调 `load_skill` 取全文；正文里提到的脚本、模板放在技能目录下，会用列表一起给出来，再用 `read_file` 按需读。正文超过 24000 字会截断，同时给出二级标题和行号，方便按段落读全文。

加载前要过审批：`GRASSAGENT_APPROVE_SKILLS` 取 `ask`（默认，输入 y 同意）、`allow`、`deny`。非交互模式没人能点头，按拒绝处理。同一批技能只问一次，会话内记住了不再重复问。

标了 `disable-model-invocation: true` 的技能只给用户手敲：不进模型索引，注册成 `/技能名`，敲出来显示正文和参数提示，不发模型。

`environments`、`disabled-environments`、`metadata.surfaces` 会按本地终端（`local` / `cli`）过滤，声明了别的环境的技能直接跳过。

技能从**执行世界**里读：`remote` 模式下读的是沙盒里的文件，来源会标成 `user@host:port`。本地扫描结果缓存在 `.grass/tmp/skills-cache.json`，按文件大小和修改时间失效。

技能目录同样必须在工作区内，指向区外的软链会跳过。用户主目录里的 `~/.cursor/skills-cursor` 这类官方技能不在扫描范围。设 `GRASSAGENT_LOAD_SKILLS=0` 关闭整个技能功能，关掉后不注册 `load_skill`。

`/skills` 列出当前技能（名字、来源、状态、路径），`/skills reload` 重新扫描并热替换工具与系统提示词。

### 监视器

`monitor` 工具用来「过一会儿再看一眼」，省得模型自己一轮轮去问。

```jsonc
// 后台跑一条命令，结束时把结果推回上下文
{ "kind": "command", "command": "npm test", "timeoutMs": 300000 }

// 跑命令，100 秒后先报一次「还在跑」，结束时再报一次
{ "kind": "command", "command": "npm run build", "afterMs": 100000 }

// 只等一段时间，到点提醒
{ "kind": "timer", "afterMs": 30000 }

// 看沙盒还在不在、连不连得上
{ "kind": "sandbox", "afterMs": 60000 }

// wait=true：在本次调用内等到结果，直接当工具结果返回
{ "kind": "command", "command": "npm test", "wait": true }
```

两种报告方式的区别：

| | 工具调用内阻塞（`wait: true`） | 后台（默认） |
| --- | --- | --- |
| 什么时候拿到 | 命令结束或到点，最长等 60 秒 | 回合结束后，报告到了再开一轮 |
| 适合 | 想要立刻看到结果 | 命令要跑很久，先干别的 |

后台报告作为一条带 `[monitor]` 标记的 user 消息进上下文——产生它的那次工具调用早就返回了，不能伪造成 `tool_result`。报告到达时如果正在跑回合，会先排队，等这一轮结束再开新的，不会插进来打断。

后台命令和 `run_bash` 一样要过审批模型和危险命令规则；只读沙盒直接拒绝。命令输出只保留尾部（8 KB），报告里再截到 2 KB。同时最多 8 个监视器，一个监视器最多报 3 次。

会话结束（Ctrl+C、stdin 读完）会取消全部监视器，并把还在跑的后台命令杀掉——监视器不活在会话之外。所以非交互模式下管道一关就会取消，看不到定时报告。

远程沙盒暂不支持 `kind: "command"`：那需要沙盒协议支持增量输出和杀进程，现在没有。`timer` 和 `sandbox` 两种在远程下可用。

### 钩子

钩子是回合上的扩展点。它不改 agent 循环本身，只在固定时刻看一眼即将发生的动作，然后允许、拒绝，或改写参数和结果。

配置放在工作区的 `.grass/hooks.json`。文件不存在就等于没配。也可以用 `GRASSAGENT_HOOKS_PATH` 指到别的文件——指了但找不到，启动会失败。

```json
{
  "PreToolUse": [
    {
      "matcher": "^run_bash$",
      "hooks": [
        { "type": "command", "command": "node .grass/guard.mjs", "timeoutMs": 5000 }
      ]
    }
  ]
}
```

`matcher` 是正则，匹配这一次事件的文本：工具事件匹配工具名，`UserPromptSubmit` 和 `Stop` 匹配提示词或模型刚说的话。不写就每次都跑。想精确匹配工具名要自己加锚点，`edit` 会命中 `edit_batch`。

命令从 **stdin** 读到一行 JSON（`hook_event_name`、`session_id`、`cwd`，工具事件还有 `tool_name` / `tool_input` / `tool_use_id`）。结果看退出码和 stdout：
| 结果 | 含义 |
| --- | --- |
| 退出码 0，stdout 为空 | 允许 |
| 退出码 0，stdout 不是 JSON | 整段文字当作额外上下文，塞给模型 |
| 退出码 0，stdout 是 JSON | 按下面的字段决定 |
| 退出码 2 | 拒绝。理由用 stderr，没有就用 stdout |
| 其他退出码 | 钩子失败，**放行**，错误打到日志和界面 |

JSON 里常用的字段：

```json
{
  "continue": true,
  "decision": "block",
  "reason": "不许删仓库",
  "systemMessage": "给用户看的一行字",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "不许删仓库",
    "updatedInput": { "command": "ls" },
    "additionalContext": "这段会进模型上下文",
    "updatedOutput": "只在 PostToolUse 里替换工具结果"
  }
}
```

`decision: "block"` 和 `permissionDecision: "deny"` 都是拒绝。拒绝是粘性的：同一个事件上，后面的钩子不能把前面的拒绝翻回来。`continue: false` 表示这步做完就结束回合，不要再问模型。

现在会触发的事件：

| 事件 | 时机 | 钩子能做什么 |
| --- | --- | --- |
| `SessionStart` | 会话加载完、界面起来之前 | 往系统提示词追加上下文；拒绝则进程直接退出 |
| `SessionEnd` | 进程退出之前 | 做收尾。这里不能挂太慢的命令，退出会等它 |
| `UserPromptSubmit` | 用户回车之后、发给模型之前 | 拦住这次输入，或往消息末尾追加上下文 |
| `PreToolUse` | 参数校验之后、工具执行之前 | 拒绝这次调用，或改写参数。改写后的参数还要再过一遍校验 |
| `PostToolUse` | 工具成功之后 | 改写回给模型的结果，或追加上下文 |
| `PostToolUseFailure` | 工具失败之后 | 同上。被 `PreToolUse` 拒绝的调用不会再进这里 |
| `Stop` | 模型没再调工具、回合即将结束 | 拒绝的话把理由塞回上下文，让模型继续。连续拉回有上限，默认 5 次 |
| `PreCompact` | 真的要压缩上下文之前 | 拒绝则这一次不压缩。历史本来就不会被改写 |

工具被拒绝或中途被 Ctrl+C 打断时，每个 `tool_call` 仍然会有一条 `tool_result`。漏掉的话，下次恢复会话会 400。

失败默认放行：脚本崩了、超时了、JSON 写坏了，都不该把整个会话卡死。想拦截就必须退出码 2，或者在 JSON 里明确写 `block` / `deny`。

目前只有 `type: "command"`。没有 HTTP、prompt、agent 这几种，也不支持 `"async": true`——写上去会在启动时被校验拒绝。

#### 几个事件专有的输入字段

| 事件 | 字段 | 含义 |
| --- | --- | --- |
| `PreToolUse` | `resolved_paths` | 路径参数解析后的真实路径。每项是 `{ requested, real, insideWorkspace }` |
| `Stop` | `stop_hook_active` | 本回合是不是已经被 Stop 钩子拉回过 |
| `Stop` | `changed_files` | 本回合实际写过的文件路径 |

`resolved_paths` 里的 `real` 是解析符号链接之后的真实路径。判断「不许写某个目录」要用它——只看模型给的原始路径，工作区里一个指向外部的软链就绕过去了。`insideWorkspace` 为 false 表示越界或解析不了。远程沙盒里没有这个字段，路径在另一台机器上，本机解析出来的结论是错的。

`stop_hook_active` 让验收脚本能收手：第一次拉回后它看到 `true`，就知道该停手而不是继续要求继续。没有这个字段，脚本很容易写成自己叫不醒自己的死循环，只能靠「连续拉回上限」（默认 5 次）兜底。

#### 可抄的配方

`.grass/hooks/` 下有两份现成的示例：

- `verify.mjs`——验收钩子。模型想停的时候自动跑检查，不过就让它再来一轮。和「在规则文件里写请运行检查脚本」的区别是**跑不跑不再由模型决定**
- `grade-feedback.mjs`——分级反馈钩子。把工具输出按阻塞/警告/信息三级改写，成功静默

用法见 `.grass/hooks/README.md`。示例配置在 `.grass/hooks/hooks.example.json`，**拷贝到 `.grass/hooks.json` 才生效**——那个路径是默认读取的位置，放上去等于默认启用。

### 提示模板

工作区的 `.grass/prompts/*.md` 每份变成一条斜杠命令。

```markdown
---
description: 把刚形成的结论固化进仓库文件
argument-hint: "[要固化的内容]"
---
请把下面这条在对话中形成的结论固化进仓库:$ARGUMENTS

按四个子系统判断它属于哪里,只改一个最合适的位置:
- 规则、流程、完成条件 → 项目规则文件
- 某个技能内部的做法 → 对应技能的 SKILL.md
```

正文里的 `$ARGUMENTS` 换成命令后面跟的全部参数，`$1`..`$9` 换成单个参数。

执行等价于「把展开后的正文当成一条用户消息发给模型」，和手打进去完全一样——钩子、会话存储、回合计数都不用另外接。命令名和内置命令冲突时跳过，内置优先。

### 非交互模式

stdin 不是终端时（管道输入、CI、IDE 插件调用），界面自动切成逐行模式：

```bash
echo "读一下 README.md" | npm start
```

这时输入按行读，回车即提交。输出里的 ANSI 控制序列会被清掉——重定向到文件时它们就是乱码。

管道输入的回合会跑完才退出，不会读到 EOF 就把回合杀在半路上。

## 配置项

全部通过 `.env` 提供，也可以用系统环境变量覆盖（**系统环境变量优先级更高**）。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `GRASSAGENT_API_KEY` | API 密钥（必填） | 无 |
| `GRASSAGENT_MODEL` | 主力模型，负责对话和解决问题 | `gpt-4o-mini` |
| `GRASSAGENT_BASE_URL` | 主力模型 API 地址 | `https://api.openai.com/v1` |
| `GRASSAGENT_SMALL_MODEL` | 小模型，负责标题和压缩摘要。留空则用主力模型 | 主力模型 |
| `GRASSAGENT_SMALL_BASE_URL` | 小模型 API 地址。留空则用主力地址 | 主力地址 |
| `GRASSAGENT_SMALL_API_KEY` | 小模型密钥。留空则用 `GRASSAGENT_API_KEY` | 主力密钥 |
| `GRASSAGENT_SMALL_MAX_TOKENS` | 小模型单次生成上限。留空则用 `GRASSAGENT_MAX_TOKENS` | 主力上限 |
| `GRASSAGENT_APPROVAL_MODEL` | 审批模型，决定写文件和命令能不能执行。留空则用主力模型 | 主力模型 |
| `GRASSAGENT_APPROVAL_BASE_URL` | 审批模型 API 地址。留空则用主力地址 | 主力地址 |
| `GRASSAGENT_APPROVAL_API_KEY` | 审批模型密钥。留空则用 `GRASSAGENT_API_KEY` | 主力密钥 |
| `GRASSAGENT_APPROVAL_MAX_TOKENS` | 审批模型单次生成上限 | `512` |
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
| `GRASSAGENT_CONTEXT_WINDOW` | 上下文窗口（token），用来判断该不该压缩 | `128000` |
| `GRASSAGENT_COMPACT_RESERVE_TOKENS` | 留给回复和摘要的 token，超过窗口减去它就开始压 | `16384` |
| `GRASSAGENT_COMPACT_KEEP_RECENT_TOKENS` | 压缩后尽量保留的最近 token | `20000` |
| `GRASSAGENT_SESSION_DATABASE_PATH` | 会话数据库路径 | `~/.grassagent/sessions.db` |
| `GRASSAGENT_SESSION_ID` | 会话 ID（留空则每次开新会话） | 自动生成 |
| `GRASSAGENT_HOOKS_PATH` | 钩子配置文件。留空则用 `<工作区>/.grass/hooks.json` | 默认路径，文件可不存在 |
| `GRASSAGENT_HOOK_TIMEOUT_MS` | 命令钩子默认超时（毫秒） | `10000` |
| `GRASSAGENT_LOAD_PROJECT_INSTRUCTIONS` | 是否识别 opencode、cursor、claude、kiro 的规则和提示词 | `1` |
| `GRASSAGENT_LOAD_SKILLS` | 是否扫描技能 | `1` |
| `GRASSAGENT_APPROVE_SKILLS` | 加载技能前是否询问。`ask` / `allow` / `deny` | `ask` |
| `GRASSAGENT_EXECUTION_WORLD` | `local` 或 `remote`。remote 失败不退回本机 | `local` |
| `GRASSAGENT_SANDBOX_MODE` | 沙盒权限模式。`read-only` / `workspace-write` / `danger-full-access` | `workspace-write` |
| `GRASSAGENT_SESSION_PROFILE` | `facing` 或 `cloud`。cloud 不带 `ask_user` | `facing` |
| `GRASSAGENT_CLOUD_SESSION_DIRECTORY` | 云端会话记录目录。不要指到工作区里 | `~/.grassagent/cloud-sessions` |
| `GRASSAGENT_TRUST_PLUGINS` | `.grass/plugins` 是否信任。`ask` / `allow` / `deny` | `ask` |
| `GRASSAGENT_PLUGIN_TRUST_FILE` | 插件信任记录。不要指到工作区里 | `~/.grassagent/plugin-trust.json` |
| `GRASSAGENT_SKILL_EVAL` | 是否打开技能评估。打开后也不进模型工具表 | `false` |

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
  → 模型决定调工具 → 工具经 ExecutionWorld 执行（本地或远程同一接口）
  → 结果回填 context，再调一次模型
  → 模型不再调工具 → 回合结束，消息写入 sessions.db
```

几个刻意保留的细节，也是这个项目想讲清楚的东西：

**回合循环不拆。** `runAgent` 仍是流式调用、执行工具、结果回填、再问模型。插件只能登记工具、世界、会话命令、provider 和提示词发现，换不掉这个循环。云端会话跑的也是同一套循环，只是工具表里没有 `ask_user`。



**`max_tokens` 截断。** 输出被截断时 tool_call 的参数 JSON 是不完整的。这里不执行它，而是把错误塞回 context，让模型重新发一次。硬执行只会拿到半个 JSON。

**abort 后的配对补全。** API 要求每个 `tool_call` 都有对应的 `tool_result`。被 Ctrl+C 打断时跳过的工具，会补上 `error:aborted`，否则下次启动恢复会话时直接 400。

**向用户提问。** 信息不足或有多种做法必须由用户决定时，模型调用 `ask_user`。这个工具独占一轮里的输入：问题显示出来，等你回车，回答作为 `tool_result` 回到模型，然后回合继续。它不会被当成一条新的用户消息，否则会和还没结束的工具调用叠在一起。

管道输入时，回合进行中到达的下一行先排队。提问就用这一行当回答；没人问的话，本轮结束再按顺序开下一轮。输入已经结束（EOF）还在等回答时，工具返回「没有用户可以回答」，模型按现有信息继续，进程不会挂住。

**模型分工。** 三个角色不串岗。主力模型只负责对话和调用工具把问题解决掉。小模型负责给会话起标题，以及在需要压缩时写出摘要。审批模型只在写文件、改文件、执行命令之前决定放不放行；读文件仍只过路径沙箱。没单独配置的角色会继承主力模型，旧的单模型配置不用改也能跑。审批请求失败，或者结论解析不了，一律拒绝执行。

**上下文压缩。** 发给模型的内容按字符数估算 token（约 4 个字符算 1 个）。超过「窗口减去预留」时，由小模型把旧消息总结成结构化摘要（目标、约束、进展、决定、验证记录、下一步），之后发给主力模型的内容变成「摘要 + 最近一段」。读过和改过的文件路径从工具调用里抽出来附在摘要后面，不靠模型回忆。压缩失败则保留原样，不会用空摘要毁掉整个会话。

摘要里的**验证记录**不能省：什么检查跑过、什么失败了、为什么失败。丢掉的只能是过程，不能是依据——依据丢了，模型会推翻既定决策或者重犯旧错。`/compact` 手动触发时还能用参数引导摘要的重点，比如 `/compact 保留验证记录和每个决策的理由`。

压缩**只改发给模型的视图，不改历史**。`context.messages` 始终是完整的，摘要单独记在 `context.compaction` 里。这一点很关键，因为改历史会出两个问题：

一是**切点可能劈开工具调用**。切点落在 `assistant(tool_use)` 和它的 `tool_result` 之间时，发出去的是一条没有来由的 `role:tool` 消息，OpenAI 侧直接 400。所以切点会往前挪，挪到不劈开为止。

二是**新消息会存不进去**。会话存储按「新增条数」增量写，历史被砍之后切片就空了，后面说的话全部消失。

窗口、预留和保留可以配：`GRASSAGENT_CONTEXT_WINDOW`（默认 128000）、`GRASSAGENT_COMPACT_RESERVE_TOKENS`（默认 16384）、`GRASSAGENT_COMPACT_KEEP_RECENT_TOKENS`（默认 20000）。保留和预留加起来必须小于窗口。本地小模型要把这三个一起改小。

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

**终端界面。** 用的是 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)（和本项目的 `pi-schema` 同一个作者，MIT 协议）。它做两件手写实现做不到的事：

一是**差分渲染**——只重画变化的行，不是整屏重排。配合 CSI 2026 同步输出做到无闪烁。边流边打印时这个差别很明显。

二是**markdown 排版**——模型输出的 `**粗体**`、代码块、列表会真的排版好，代码块带缩进和边框。

流式输出有个细节：markdown 组件是整块渲染的，没法边流边排版。所以流式期间用纯文本组件累积（渲染快），回合结束后换成 markdown 组件重新排版一次。用户看到的是「先出字，后成型」，而不是等全部收完才突然排好版。

配色在 `src/ui/theme.ts`，用的是 pi-tui 自带的 `styleText`（不引 chalk）——它会按终端能力降级，真彩色不够时自动降到 256 色。

**工具并发执行。** 一轮里多个 tool_call 会并发跑，不用排队等。模型要改三个文件时，三个写入同时进行。

但并发有个陷阱：`edit` 是「读-改-写」三步，两个并发 edit 同一文件会互相覆盖。所以工具可以声明自己会修改哪些文件（`mutatesFiles: ['path']`），这类操作按文件真实路径排队——同一文件依次执行，不同文件照常并行。`write_file` 和 `edit` 都做了声明。

队列是可重入的：工具内部自己再包一层也不会死等。同一文件的操作严格按调用顺序执行，模型说「先写 A 再改 A」就是这个顺序。

一个工具要改多个文件时，会按路径排序后依次拿锁——所有工具用同一套排序，不会出现两个工具互相等对方锁的死锁。

还有一种是工具压根不该并发：声明 `sequential: true`，它就会单独跑，不和同一轮里的其他工具抢跑。

结果事件的顺序始终和模型发出的顺序一致，不按完成顺序——UI 显示和模型意图能对上，排障时不用猜。

想退回串行：`GRASSAGENT_TOOL_EXECUTION=sequential`。

**会话存储。** 会话历史存在 SQLite 里（`~/.grassagent/sessions.db`），用的是 Node 内置的 `node:sqlite`，不引运行时依赖。

WAL 模式 + `busy_timeout`，多个进程可以同时读写同一个数据库文件。每个进程有独立的 `sessionId`，各存各的会话，互不干扰——允许多实例同时跑。

写入按「新增条数」增量进行。但历史有可能被整体换掉（`/clear` 清空、`/resume` 切换会话），这时存储层会对账——发现内容对不上就删掉旧内容重写，不然按条数切片会算错，新消息一条也写不进去。

`node:sqlite` 目前是实验性 API，会打印 `ExperimentalWarning`。启动脚本已加 `--disable-warning=ExperimentalWarning` 精确静音这一类警告（其他警告不受影响），`src/session/sessionStore.ts` 里还有一层运行时兜底，直接跑 `node src/cli.ts` 也是干净的。

> 早期版本用 JSONL 文件存会话。升级后旧文件不会自动导入，需要的话可以自己写脚本转换。

## 测试

```bash
npm run test:unit    # 单元测试：config / pathGuard / retry / transport / tools / validation / provider / sessionStore / sessionBundle / projectInstructions / mutationQueue / parallelTools / compaction / slashCommands / sessionPicker / nonInteractiveTerminal / hooks / hookConfig / agentHooks
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

另外 `test/cli/nonInteractiveCli.test.ts` 会起子进程跑真实入口，验证管道输入下的完整链路：回合跑完才退出、输出没有 ANSI 残留、斜杠命令在本地执行不发给模型。

用本地 mock 而不是真实 API，测试才稳定可复现，也不消耗额度。

## 发布

推一个 `v*` tag 就会触发 `.github/workflows/publish.yml`：跑完整测试、校验版本、编译、检查发布包内容，然后发布到 npm。

```bash
# 先把 package.json 的 version 改成目标版本并提交
git tag v0.3.0
git push origin v0.3.0
```

也可以在 GitHub Actions 页面手动运行 **Publish to npm**（`workflow_dispatch`），发布当前 `package.json` 的版本——`v0.2.0` 比这个工作流更早，用它补发首个包不用重打 tag。

### 首次发布：Granular Access Token

npm 在 2025-12-09 永久撤销了 classic token（老教程里的 Automation token 也在内），网页上已经没这个选项。现在到 npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**，把生成的 token 存进仓库 Settings → Secrets and variables → Actions，名字 `NPM_TOKEN`：

- **Bypass two-factor authentication 必须勾**。npm 现在要求所有包发布都过 2FA 或带 bypass 的 token，CI 里没法交互输验证码，不勾会卡在 2FA 上失败。账户本身建议开启 2FA，两者不冲突——勾了这个选项的 token 会绕过账户级和包级的 2FA 要求。
- Packages and scopes → `Read and write (publish and stage)`；Select packages 选 `All packages`（包还不存在，下拉里选不到），发布成功后收窄到 `grassagent`。
- Organizations → `No access`；Expiration 最长 **90 天**，到期前要轮换，否则 CI 会突然认证失败。

带 bypass 2FA 的 token 是过渡方案：npm 计划 2027 年 1 月起取消它直接发布的能力。

### 之后：Trusted Publishing（OIDC）

不需要任何长期 token，也绕开 2FA 交互，发布自动附带 provenance。但 npm 不给还不存在的包配 Trusted Publisher，所以要先用上面的 token 发一次，让包存在，然后：

1. npmjs.com → `grassagent` → Settings → Trusted Publisher → GitHub Actions：owner `gggtttfff`、repo `GrassAgent`、workflow filename `publish.yml`、environment 留空、Allowed actions 勾 **`npm publish`**（2026-09-03 之后新建的配置默认只允许 stage）。
2. 删掉仓库里的 `NPM_TOKEN` secret。工作流检测到 secret 为空就自动走 OIDC，代码不用改，`id-token: write` 权限已经加好。
3. 配置要在 **2 天内**完成一次成功发布，否则过期得删掉重建。首个 OIDC 发布建议用推 tag 触发，别用手动触发（OIDC 校验的是调用方工作流名）。

`package.json` 的 `repository.url` 要与 GitHub 仓库地址精确匹配，否则 provenance 校验会报 422。

### 校验

工作流会拦下：tag 与 `package.json` 版本不一致、该版本已发过、包里没有 `dist/cli.js` 或它丢了 shebang。`dist/` 在 `.gitignore` 里，checkout 带不下来，所以靠 `prepublishOnly` 在发布前编译，`files` 白名单负责把编译产物打进包（白名单优先于 `.gitignore`）。手动 `npm publish` 走的是同一套编译。

发布命令返回后还会轮询最多 10 分钟（每 20 秒一次），确认 `npm view grassagent@<version>` 能查到才判成功。首次发布存在约 5 分钟的异步窗口：CLI 已经打印 `+ grassagent@0.2.0`，registry 上却还只有 `0.0.0-stage` 占位包，此时包是可望不可装的；不做这一步校验就会出现「工作流全绿但装不到」。占位版本会残留在版本列表里，不影响 `latest`。

## 扩展

### 加一个新 provider

在 `src/llm/providers/` 下新建文件，实现 `Provider` 接口——消息转换 + 流式解析：

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

然后在 `src/llm/providers/index.ts` 里 `registerProvider(myProvider)`。

内部消息模型不会泄漏到协议层——转换只在你自己的 `stream` 里做。

### 加一个新工具

在 `src/agent/tools.ts` 里写工厂函数，文件和命令走 `WorldPort`（由 `ExecutionWorld` 收窄而来）：

```typescript
function buildMyTool(world: WorldPort): AgentTool {
  return {
    name: 'my_tool',
    description: '工具做什么，写给模型看的',
    parameters: { type: 'object', properties: { ... }, required: [...] },
    // 会修改文件的话声明一下,并发执行时同一文件的操作会排队
    mutatesFiles: ['path'],
    execute: async (args) => {
      // 涉及文件或命令时走 world，不要直接用 node:fs
      return '结果字符串'
    }
  }
}
```

然后加进 `builtinTools()` 的返回数组，并在 `src/plugin/host.ts` 的对应清单里写上同名工具。启动时两边对不上会直接退出。工具是纯函数，不持有 agent 状态。工作区 `.grass/plugins` 只登记清单，不会把这里的函数加载进去。

不声明 `mutatesFiles` 的工具可以自由并发。声明了但操作的是「读-改-写」流程的（像 `edit`），必须声明，否则并发时会丢更新。

工具压根不该并发（比如要独占某个资源），声明 `sequential: true`，它会单独跑，不和同一轮里的其他工具抢跑。

### 加一个钩子

不想写 JSON 的话，可以在进程里直接注册函数钩子。命令钩子和函数钩子走同一份结果：

```typescript
import { createHookRunner } from './agent/hooks.ts'

const hooks = createHookRunner([
  {
    event: 'PreToolUse',
    matcher: /^run_bash$/,
    handler: (input) => {
      const command = (input.tool_input as { command?: string }).command ?? ''
      if (command.includes('rm -rf')) return { decision: 'block', reason: '不许删仓库' }
    },
  },
], { sessionId, cwd: workspace, defaultTimeoutMs: 10_000 })
```

把 `hooks` 传给 `runAgent` 的 `options.hooks`。`SessionStart` / `SessionEnd` / `UserPromptSubmit` 是命令行入口在回合外面触发的，只调用 `runAgent` 时不会自动跑这三个。

## License

[MIT](./LICENSE) © Pieory
