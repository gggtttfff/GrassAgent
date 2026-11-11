---
name: remote-ssh-boot
description: 启动或排查 GrassAgent 的远程 SSH 执行世界。配 .env 走 SSH 后端、首次部署到远程主机、连接/部署/探活任一步失败时对照排查。
---

# 远程 SSH 执行世界：启动与排查

把文件读写和命令执行交给一台远程机器。模型看到的根是 `/workspace`，
对应远程上的真实目录（默认 `/root/grass-workspace`）。

## 一、判断走哪条路

先看要不要独立部署控制面：

- **要跑远程** —— 只配 `GRASSAGENT_SANDBOX_BACKEND=ssh`，**不填** `GRASSAGENT_SANDBOX_CONTROL_URL`。
  这时控制面在 Grass 进程里起，只监听回环，`npm start` 一个进程就够。
  依据：`src/sandbox/openWorld.ts` 里 `!config.SandboxControlUrl && config.SandboxBackend === 'ssh'`
  的分支直接走 `openInProcessControlPlane`。
- **填了控制面地址** —— 走独立控制面进程（`npm run sandbox:control`），要自己管它的生命周期。
  排查远程部署问题时优先走第一条，少一个变量。

## 二、前置检查

远程主机（缺一不可，用 `command -v` 逐个确认）：

| 依赖 | 用途 | 说明 |
|---|---|---|
| Node ≥ 24.3 | 跑 daemon | daemon 是 `.ts` 源码，靠 type stripping 直接跑，`24.3` 才默认开启 |
| SFTP 子系统 | 传文件 | `sshd_config` 里要有 `Subsystem sftp` |
| curl | 探活 daemon | `waitForDaemon` 用它在远程发 health 请求 |
| nohup / pkill / rm | 起停 daemon | 缺了起不来也清不掉 |

远程**不需要装任何 npm 包**——daemon 只用 Node 内置模块。

本地要备好：私钥文件、known_hosts。两者都可以写 `~` 开头，`resolveSshConfig` 会展开。

## 三、配置 .env

```bash
GRASSAGENT_EXECUTION_WORLD=remote
GRASSAGENT_SANDBOX_BACKEND=ssh
GRASSAGENT_SANDBOX_SSH_HOST=<主机>
GRASSAGENT_SANDBOX_SSH_PORT=<端口，不是 22 才要填>
GRASSAGENT_SANDBOX_SSH_USER=<用户名>
GRASSAGENT_SANDBOX_SSH_KEY_PATH=<私钥绝对路径>
GRASSAGENT_SANDBOX_SSH_KNOWN_HOSTS_PATH=<known_hosts 绝对路径>
GRASSAGENT_SANDBOX_SSH_WORKSPACE=<远程工作区绝对路径>
```

校验规则（`src/config.ts`）：ssh 后端**不要求** `SANDBOX_CONTROL_URL` 和 `SANDBOX_IMAGE`，
但 `SANDBOX_SSH_HOST` 和 `SANDBOX_SSH_USER` 必填。

## 四、启动

```bash
npm start
```

首次约 15~45 秒，之后在远程完成第一轮对话即可验证。

## 五、内部做了什么

首回合走 `sshBackend.provision` → `deployRemoteDaemon`，顺序固定：

1. **连 SSH** —— 校验主机密钥
2. **开一条 SFTP 会话** —— 全程复用这一条，不要一个操作开一条（11 个文件会握手二十多次）
3. **逐级建目录** —— SFTP 的 mkdir 不递归，要从根往下逐层建
4. **传 11 个源文件** —— `sshDeploy.ts` 的 `DAEMON_SOURCES`
5. **写令牌** —— 远程 `0600` 文件，daemon 每次调用都读它比对
6. **起 daemon** —— `--host 127.0.0.1 --port 0`，端口交给系统分配，再从 `daemon.log`
   里读回 `daemon listening http://127.0.0.1:PORT`
7. **开隧道 + 探活** —— 本机回环起随机端口，透明 TCP 转发（不解析内容），再发 health 确认协议版本

## 六、故障对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `远程 daemon 没起来: {"ok":false,"code":"version","error":"需要协议版本 N"}` | 探活请求里的协议版本写死，和 `SANDBOX_PROTOCOL_VERSION` 对不上 | 探活必须引用常量，不要写死字面量 |
| `远程 daemon 启动失败: ...` | daemon 日志里有 Error | 去远程看 `/tmp/grass-<id>/daemon.log` |
| `远程 daemon 没有报出监听端口` | 日志里没有 listening 行 | 同上，通常是工作区 realpath 失败 |
| `远程 Node 版本 vX 太低` | 低于 24.3 | 升级远程 Node |
| `主机密钥指纹变了，拒绝连接` | 远程重装或换了密钥 | 核对后删掉 known_hosts 里对应行再连 |
| `控制面不可达` | 配了 CONTROL_URL 但服务没起 | 要么起服务，要么删掉这行走进程内控制面 |
| 第二个沙盒报「令牌被拒绝」 | daemon 端口写死，两个沙盒抢同一个端口 | 必须 `--port 0` 让系统分配 |

## 七、验证确实跑在远程

模型容易把「广告路径 `/workspace`」当成远程的证据，其实判断不了。用命令验证：

```bash
hostname        # 应该是远程主机名
pwd             # 应该是远程工作区的真实路径
```

本地对照 `hostname` 即可确认。远程侧直接查：

```bash
ps -eo pid,etime,cmd | grep daemon.ts | grep -v grep
ls -d /tmp/grass-*
```

## 八、清理

`Ctrl+C` 或会话结束 → `world.close()` → 停隧道 → 杀远程 daemon（先按 `daemon.pid`，
再按路径 `pkill` 兜底）→ `rm -rf /tmp/grass-<id>`。

**工作区内容不会被清掉** —— `stop()` 只删源码目录。想清工作区得自己动手。

## 九、已知限制

- **挂回不支持**：`sshBackend.attach` 直接返回 `null`。远程目录跟着 daemon 一起删了，
  没有可留下的卷。所以 `SANDBOX_ID` 配了也没用，会报「沙盒卷不存在，不能挂回」。
- **known_hosts 非标端口比对不上**（未修）：代码用 `host:port` 拼键，
  但 OpenSSH 对非 22 端口写成 `[host]:port`。结果是有记录也命中不了，
  每次都落进 TOFU 分支放行，只打一条 warn。修法是查找时两种键都试一下。
- **技能在 remote 模式下读远程的**：`cli.ts` 用 `createWorldSkillFiles(world)`，
  所以本地 `.grass/skills` 在远程模式里看不到。另外远程启动失败时进程在扫描技能之前
  就退出了，这个技能只在本地模式下帮得上忙。