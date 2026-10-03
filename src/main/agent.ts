import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentId } from '../shared/types'
import { getShellEnv } from './shell-env'

const require = createRequire(import.meta.url)

interface SpawnSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

function packageDir(name: string) {
  return dirname(require.resolve(`${name}/package.json`)).replace('app.asar', 'app.asar.unpacked')
}

const ADAPTERS: Record<AgentId, string> = {
  claude: '@agentclientprotocol/claude-agent-acp',
  codex: '@agentclientprotocol/codex-acp',
}

/**
 * Both adapters are Node programs; run them on Electron's bundled Node runtime.
 * The bootstrap drops ELECTRON_RUN_AS_NODE once Node is up, so it doesn't leak into
 * commands the agent runs (it would break any Electron binary they start).
 */
function spawnSpec(id: AgentId): SpawnSpec {
  const entry = pathToFileURL(join(packageDir(ADAPTERS[id]), 'dist/index.js')).href
  const bootstrap = `delete process.env.ELECTRON_RUN_AS_NODE; import(${JSON.stringify(entry)}).catch((error) => { console.error(error); process.exit(1) })`
  return { command: process.execPath, args: ['-e', bootstrap], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export type PermissionResolver = (optionId: string | null) => void

export interface AgentHandlers {
  onUpdate(update: acp.SessionNotification['update']): void
  onPermission(request: acp.RequestPermissionRequest, resolve: PermissionResolver): void
  onExit(error: string | null): void
}

export interface AgentInfo {
  supportsImages: boolean
  modeName: string | null
  modes: { id: string; name: string }[]
}

/** One ACP agent process with a single session rooted at the project. */
export class AgentSession {
  private child: ChildProcess | null = null
  private connection: acp.ClientConnection | null = null
  private sessionId: string | null = null
  private stderr = ''
  private disposed = false
  /** Rejects with the agent's own error output if the process dies. */
  private exited: Promise<never> = new Promise(() => {})

  constructor(
    readonly agentId: AgentId,
    private readonly cwd: string,
    private readonly handlers: AgentHandlers,
  ) {}

  async start(): Promise<AgentInfo> {
    const spec = spawnSpec(this.agentId)
    const shellEnv = await getShellEnv()
    if (this.disposed) throw new Error('Agent was stopped')
    // Own process group, so dispose() can stop the agent and everything it started.
    const child = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      env: { ...shellEnv, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    this.exited = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code, signal) => reject(new Error(this.exitMessage(code, signal))))
    })
    this.exited.catch(() => undefined)
    child.once('exit', (code, signal) => {
      if (!this.disposed) this.handlers.onExit(this.exitMessage(code, signal))
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    if (!child.stdin || !child.stdout) throw new Error('Agent process has no stdio')
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )

    const app = acp
      .client({ name: 'grat' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (ctx.params.sessionId === this.sessionId) this.handlers.onUpdate(ctx.params.update)
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          this.handlers.onPermission(ctx.params, (optionId) =>
            resolve({
              outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
            }),
          )
        })
      })
    this.connection = app.connect(stream)
    const agent = this.connection.agent

    const init = await this.untilExit(
      agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'grat', version: '0.1.0' },
      }),
    )

    const session = await this.untilExit(
      agent.request(acp.methods.agent.session.new, { cwd: this.cwd, mcpServers: [] }),
    ).catch((error: unknown) => {
      throw new Error(describeStartError(error, this.agentId))
    })
    this.sessionId = session.sessionId

    // Keep the mode the user's own agent config chose; Grat's permission policy
    // (ChatController.onPermission) decides what to auto-approve when the agent asks.
    const modes = session.modes
    const modeList = modes?.availableModes.map(({ id, name }) => ({ id, name })) ?? []
    const modeName = modeList.find((mode) => mode.id === modes?.currentModeId)?.name ?? null

    return {
      supportsImages: init.agentCapabilities?.promptCapabilities?.image === true,
      modeName,
      modes: modeList,
    }
  }

  async prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const { connection, sessionId } = this
    if (!connection || !sessionId) throw new Error('Agent is not running')
    return this.untilExit(
      connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks }),
    )
  }

  async cancel() {
    const { connection, sessionId } = this
    if (!connection || !sessionId) return
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.connection?.close()
    this.connection = null
    const child = this.child
    this.child = null
    if (!child?.pid || child.exitCode !== null) return
    const pid = child.pid
    killGroup(pid, 'SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killGroup(pid, 'SIGKILL')
    }, 2000).unref()
  }

  private untilExit<T>(promise: Promise<T>) {
    return Promise.race([promise, this.exited])
  }

  private exitMessage(code: number | null, signal: NodeJS.Signals | null) {
    const detail = this.stderr.trim().split('\n').slice(-3).join('\n')
    return `Agent exited (${signal ?? code})${detail ? `: ${detail}` : ''}`
  }
}

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

function describeStartError(error: unknown, agentId: AgentId) {
  const message = error instanceof Error ? error.message : String(error)
  if (/auth/i.test(message)) {
    return agentId === 'claude'
      ? 'Claude Code is not signed in. Run `claude` in a terminal and log in, then retry.'
      : 'Codex is not signed in. Run `codex login` in a terminal, then retry.'
  }
  return message
}
