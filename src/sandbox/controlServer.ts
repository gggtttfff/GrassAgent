// src/sandbox/controlServer.ts
// 控制面的命令行入口。只绑 127.0.0.1。
// 这个进程不读 GRASSAGENT_API_KEY,避免密钥出现在控制面的环境快照里被打进日志。
//
// HTTP 服务本体在 controlHttp.ts。这里只负责选后端、起服务。

import * as path from 'node:path'
import { createDockerBackend } from './dockerBackend.ts'
import { createInProcessBackend } from './inProcessBackend.ts'
import { createSshBackend, type SshBackendOptions } from './sshBackend.ts'
import { createControlPlane } from './control.ts'
import { listenControl } from './controlHttp.ts'

async function main(): Promise<void> {
  const host = process.env.GRASSAGENT_SANDBOX_CONTROL_HOST || '127.0.0.1'
  const port = Number(process.env.GRASSAGENT_SANDBOX_CONTROL_PORT || 9473)
  const backendName = process.env.GRASSAGENT_SANDBOX_BACKEND || 'docker'
  const stateDir = process.env.GRASSAGENT_SANDBOX_STATE_DIR
    || path.join(process.env.HOME || '/tmp', '.grassagent', 'sandboxes')
  const credentialsFile = process.env.GRASSAGENT_SANDBOX_CREDENTIALS_FILE || undefined
  const backend = backendName === 'inprocess'
    ? createInProcessBackend({ stateDir })
    : backendName === 'ssh'
      ? createSshBackend(sshBackendOptionsFromEnv())
      : createDockerBackend({ stateDir })
  const plane = createControlPlane({
    backend,
    credentialsFile,
    // 控制面暴露到网络时,调用方必须带这个令牌。
    controlToken: process.env.GRASSAGENT_SANDBOX_CONTROL_TOKEN || undefined,
  })
  const listening = await listenControl(plane, { host, port })
  process.stdout.write(`grass sandbox control ${listening.url}\n`)
}

/**
 * 从环境变量读 SSH 后端的配置。
 *
 * 控制面是独立进程,不加载 .env——它只认环境变量。
 * 变量名和 config.ts 里的一样,方便两处对得上。
 *
 * 作者：Pieory 创建日期：2025-07-18
 */
function sshBackendOptionsFromEnv(): SshBackendOptions {
  const host = process.env.GRASSAGENT_SANDBOX_SSH_HOST
  const username = process.env.GRASSAGENT_SANDBOX_SSH_USER
  if (!host) throw new Error('SSH 后端缺少 GRASSAGENT_SANDBOX_SSH_HOST')
  if (!username) throw new Error('SSH 后端缺少 GRASSAGENT_SANDBOX_SSH_USER')
  return {
    host,
    username,
    port: Number(process.env.GRASSAGENT_SANDBOX_SSH_PORT || 22),
    privateKeyPath: process.env.GRASSAGENT_SANDBOX_SSH_KEY_PATH,
    privateKeyPassphrase: process.env.GRASSAGENT_SANDBOX_SSH_KEY_PASSPHRASE,
    agentPath: process.env.GRASSAGENT_SANDBOX_SSH_AGENT,
    password: process.env.GRASSAGENT_SANDBOX_SSH_PASSWORD,
    knownHostsPath: process.env.GRASSAGENT_SANDBOX_SSH_KNOWN_HOSTS_PATH,
    remoteWorkspace: process.env.GRASSAGENT_SANDBOX_SSH_WORKSPACE,
    healthTimeoutMs: Number(process.env.GRASSAGENT_SANDBOX_SSH_HEALTH_TIMEOUT_MS || 30_000),
    callTimeoutMs: Number(process.env.GRASSAGENT_SANDBOX_SSH_CALL_TIMEOUT_MS || 30_000),
    timeoutMs: Number(process.env.GRASSAGENT_SANDBOX_SSH_TIMEOUT_MS || 30_000),
  }
}

function isControlEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const base = path.basename(entry)
  return base === 'controlServer.ts' || base === 'controlServer.js'
}

if (isControlEntry()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  })
}
