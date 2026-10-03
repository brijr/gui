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

  constructor(
    readonly agentId: AgentId,
    private readonly cwd: string,
    private readonly handlers: AgentHandlers,
  ) {}

  async start(): Promise<AgentInfo> {
    const spec = spawnSpec(this.agentId)
    const shellEnv = await getShellEnv()
    const child = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      env: { ...shellEnv, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    child.once('exit', (code, signal) => {
      if (this.disposed) return
      const detail = this.stderr.trim().split('\n').slice(-3).join('\n')
      this.handlers.onExit(`Agent exited (${signal ?? code})${detail ? `: ${detail}` : ''}`)
    })
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    await spawned

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

    const init = await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'grat', version: '0.1.0' },
    })

    const session = await agent
      .request(acp.methods.agent.session.new, { cwd: this.cwd, mcpServers: [] })
      .catch((error: unknown) => {
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
    return connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks })
  }

  async cancel() {
    const { connection, sessionId } = this
    if (!connection || !sessionId) return
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
  }

  dispose() {
    this.disposed = true
    this.connection?.close()
    this.connection = null
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM')
    this.child = null
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
