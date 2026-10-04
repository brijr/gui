import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { type AgentId, agentName } from '../shared/types'
import { pinnedAgent, requireAgentBinary } from './agent-binaries'
import { type AgentDefinition, findExecutable, resolveAgent } from './agents'
import { DetailedError } from './errors'
import { MCP_SERVER_NAME, PREVIEW_TOOL_NAMES } from './mcp-server'
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

/**
 * Claude asks before calling MCP tools; Grat's preview tools only look at the preview,
 * so allow them up front by exact name. (Codex reviews these calls itself.)
 */
function sessionMeta(id: AgentId) {
  if (id !== 'claude') return undefined
  const allowedTools = PREVIEW_TOOL_NAMES.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`)
  return { claudeCode: { options: { allowedTools } } }
}

/**
 * Claude Code and Codex aren't shipped with Grat: each adapter reads where its CLI is
 * (the user's own install, or the copy Grat downloaded) from the environment.
 */
const CLI_PATH_ENV = { claude: 'CLAUDE_CODE_EXECUTABLE', codex: 'CODEX_PATH' } as const

/**
 * Bundled adapters are Node programs; run them on Electron's bundled Node runtime.
 * The bootstrap drops ELECTRON_RUN_AS_NODE once Node is up, so it doesn't leak into
 * commands the agent runs (it would break any Electron binary they start).
 * Every other agent is a CLI the user installed, resolved on their login-shell PATH.
 */
async function requireExecutable(agent: AgentDefinition, command: string, env: NodeJS.ProcessEnv) {
  const path = await findExecutable(command, env.PATH)
  if (!path) {
    throw new DetailedError(
      `${agent.name} isn't installed. Install it from Settings → Agents, then try again.`,
      `\`${command}\` wasn't found on your login shell's PATH.`,
    )
  }
  return path
}

async function spawnSpec(agent: AgentDefinition, env: NodeJS.ProcessEnv): Promise<SpawnSpec> {
  const { launch } = agent
  if (launch.kind === 'command') {
    const command = await requireExecutable(agent, launch.command, env)
    return { command, args: launch.args, env: launch.env }
  }
  if (launch.requires) await requireExecutable(agent, launch.requires, env)
  const entry = pathToFileURL(join(packageDir(launch.package), 'dist/index.js')).href
  const bootstrap = `delete process.env.ELECTRON_RUN_AS_NODE; import(${JSON.stringify(entry)}).catch((error) => { console.error(error); process.exit(1) })`
  const adapterEnv: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', ...launch.env?.() }
  const pinned = pinnedAgent(agent.id)
  if (pinned) adapterEnv[CLI_PATH_ENV[pinned]] = (await requireAgentBinary(pinned)).path
  return { command: process.execPath, args: ['-e', bootstrap], env: adapterEnv }
}

export type PermissionResolver = (optionId: string | null) => void

export interface AgentHandlers {
  onUpdate(update: acp.SessionNotification['update']): void
  onPermission(request: acp.RequestPermissionRequest, resolve: PermissionResolver): void
  onExit(error: DetailedError): void
}

export interface AgentInfo {
  sessionId: string
  /** True when an earlier session was resumed, so the agent remembers prior turns */
  resumed: boolean
  supportsImages: boolean
  /** Grat's preview tools were offered (the agent takes HTTP MCP servers) */
  previewTools: boolean
  modeName: string | null
  modes: { id: string; name: string }[]
}

export interface StartOptions {
  mcpServers: acp.McpServer[]
  /** Session to resume (via session/load) when the agent supports it */
  resumeSessionId?: string | null
  /** ACP auth method to run before creating the session (e.g. a browser sign-in) */
  authenticate?: string
}

export interface AuthMethod {
  id: string
  name: string
  description: string | null
  /**
   * Set for terminal sign-in: arguments for the agent's own program, which the client
   * runs itself (ACP forbids passing these methods to `authenticate`).
   */
  terminalArgs: string[] | null
}

/** The agent is installed but needs the user to sign in. */
export class AgentAuthError extends Error {
  constructor(
    message: string,
    readonly methods: AuthMethod[],
  ) {
    super(message)
  }
}

/** The useful part of an agent's error; some put it in `data` behind a generic message. */
function errorDetail(error: unknown) {
  if (error instanceof acp.RequestError && typeof error.data === 'string' && error.data.trim()) {
    return error.data.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Phrases agents use for a missing or expired login. Whole words only: a bare "auth"
 * substring also matches unrelated errors (e.g. "author", "OAuth").
 */
const AUTH_ERROR =
  /\b(?:auth(?:entication)? (?:is )?required|authenticat(?:e|ion)\b|unauthori[sz]ed|not (?:logged|signed) in|(?:log ?in|sign ?in) (?:is )?required|please (?:log|sign) ?in|(?:invalid|missing|expired) (?:api key|credentials?|token)|no credentials|401\b)/i

function isAuthError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  const message = errorDetail(error)
  // -32000 is ACP's auth_required.
  return code === -32000 || AUTH_ERROR.test(message)
}

/** The agent's own reason (when it says more than "auth required") plus how to sign in. */
function signInMessage(agent: AgentDefinition, error: unknown) {
  const detail = errorDetail(error)
    .replace(/^Authentication required:?\s*/i, '')
    .trim()
  const lead = detail ? detail.replace(/[.\s]*$/, '.') : `${agent.name} is not signed in.`
  return agent.signIn ? `${lead} ${agent.signIn}` : lead
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

  async start({ mcpServers, resumeSessionId, authenticate }: StartOptions): Promise<AgentInfo> {
    // Looked up at start, so edits to agents.json apply to the next session.
    const [definition, shellEnv] = await Promise.all([resolveAgent(this.agentId), getShellEnv()])
    if (this.disposed) throw new Error('Agent was stopped')
    const spec = await spawnSpec(definition, shellEnv)
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
      child.once('exit', (code, signal) => reject(this.exitError(code, signal)))
    })
    this.exited.catch(() => undefined)
    child.once('exit', (code, signal) => {
      if (!this.disposed) this.handlers.onExit(this.exitError(code, signal))
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
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Grat runs terminal sign-in itself (agent-status.ts); Claude only offers it then.
          auth: { terminal: true },
        },
        clientInfo: { name: 'grat', version: '0.1.0' },
      }),
    )

    // ACP clients may only pass HTTP MCP servers to agents that advertise support.
    const httpMcp = init.agentCapabilities?.mcpCapabilities?.http === true
    const servers = mcpServers.filter(
      (server) => httpMcp || !('type' in server && server.type === 'http'),
    )

    if (authenticate) {
      await this.untilExit(
        agent.request(acp.methods.agent.authenticate, { methodId: authenticate }),
      )
    }

    // sessionId stays null while loading, so the agent's replay of the old
    // transcript isn't mistaken for a new turn's updates.
    let session: { sessionId: string; modes?: acp.SessionModeState | null } | null = null
    let resumed = false
    if (resumeSessionId && init.agentCapabilities?.loadSession) {
      const loaded = await this.untilExit(
        agent.request(acp.methods.agent.session.load, {
          sessionId: resumeSessionId,
          cwd: this.cwd,
          mcpServers: servers,
          _meta: sessionMeta(this.agentId),
        }),
      ).catch(() => null)
      if (loaded) {
        session = { sessionId: resumeSessionId, modes: loaded.modes }
        resumed = true
      }
    }
    session ??= await this.untilExit(
      agent.request(acp.methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers: servers,
        _meta: sessionMeta(this.agentId),
      }),
    ).catch((error: unknown) => {
      if (!isAuthError(error)) throw new Error(errorDetail(error))
      // Only offer sign-in flows Grat knows open a browser; others are run in a terminal.
      const methods = definition.inAppSignIn
        ? (init.authMethods ?? []).map(
            (method): AuthMethod => ({
              id: method.id,
              name: method.name,
              description: method.description ?? null,
              terminalArgs:
                'type' in method && method.type === 'terminal' ? (method.args ?? []) : null,
            }),
          )
        : []
      throw new AgentAuthError(signInMessage(definition, error), methods)
    })
    this.sessionId = session.sessionId

    // Keep the mode the user's own agent config chose; Grat's permission policy
    // (ChatController.onPermission) decides what to auto-approve when the agent asks.
    const modes = session.modes
    const modeList = modes?.availableModes.map(({ id, name }) => ({ id, name })) ?? []
    const modeName = modeList.find((mode) => mode.id === modes?.currentModeId)?.name ?? null

    return {
      sessionId: session.sessionId,
      resumed,
      supportsImages: init.agentCapabilities?.promptCapabilities?.image === true,
      previewTools: servers.length > 0,
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

  private exitError(code: number | null, signal: NodeJS.Signals | null) {
    const output = this.stderr.trim().split('\n').slice(-3).join('\n')
    const how = signal ? `Exited on ${signal}` : `Exited with code ${code}`
    return new DetailedError(
      `${agentName(this.agentId)} stopped unexpectedly.`,
      output ? `${how}:\n${output}` : how,
    )
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
