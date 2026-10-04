import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { type AgentId, type AgentSetting, agentName, type ModelSettings } from '../shared/types'
import { pinnedAgent, requireAgentBinary } from './agent-binaries'
import {
  type AgentDefinition,
  findExecutable,
  type PermissionControls,
  type PermissionPolicy,
  resolveAgent,
} from './agents'
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
 * `_meta` for session/new and session/load. Claude asks before calling MCP tools; Gui's
 * preview tools only look at the preview, so allow them up front by exact name. (Codex
 * reviews these calls itself.) Agents that take Ask or Auto only as a session starts
 * (Grok) get it here.
 */
function sessionMeta(agent: AgentDefinition, policy: PermissionPolicy | undefined) {
  const permissions = policy ? agent.permissions?.sessionMeta?.[policy] : undefined
  if (agent.id !== 'claude') return permissions
  const allowedTools = PREVIEW_TOOL_NAMES.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool}`)
  return { ...permissions, claudeCode: { options: { allowedTools } } }
}

/**
 * Claude Code and Codex aren't shipped with Gui: each adapter reads where its CLI is
 * (the user's own install, or the copy Gui downloaded) from the environment.
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
  /** Gui's preview tools were offered (the agent takes HTTP MCP servers) */
  previewTools: boolean
  modeName: string | null
  /** The session's model and effort choices, when the agent offers them */
  models: ModelSettings | null
}

export interface StartOptions {
  mcpServers: acp.McpServer[]
  /** Session to resume (via session/load) when the agent supports it */
  resumeSessionId?: string | null
  /** ACP auth method to run before creating the session (e.g. a browser sign-in) */
  authenticate?: string
  /**
   * The project's Ask or Auto, for agents that only take it as a session starts
   * (PermissionControls.sessionMeta). Health checks, which never prompt, leave it out.
   */
  permissions?: PermissionPolicy
}

/** One change Ask or Auto makes to a session: a config option, or its ACP session mode. */
type PermissionChange =
  | { kind: 'option'; configId: string; value: string }
  | { kind: 'mode'; modeId: string }

/**
 * What Ask or Auto changes in a session (see PermissionControls): for each control, the
 * first value it prefers that the session offers, unless that's already set. A control
 * offering none of them keeps the agent's own setting. The mode goes through the
 * session's `mode` config option when it has one, else through session/set_mode.
 */
function permissionChanges(
  controls: PermissionControls | undefined,
  policy: PermissionPolicy,
  configOptions: acp.SessionConfigOption[],
  modes: acp.SessionModeState | null,
): PermissionChange[] {
  const pick = (wanted: string[], offered: string[], current: string) => {
    const value = wanted.find((choice) => offered.includes(choice))
    return value !== undefined && value !== current ? value : null
  }
  const changes: PermissionChange[] = []
  if (controls?.mode) {
    const wanted = controls.mode[policy]
    const option = selectSetting(configOptions, 'mode')
    if (option) {
      const value = pick(wanted, settingValues(option), option.value)
      if (value !== null) changes.push({ kind: 'option', configId: option.id, value })
    } else if (modes && Array.isArray(modes.availableModes)) {
      const offered = modes.availableModes.map((mode) => mode.id)
      const modeId = pick(wanted, offered, modes.currentModeId)
      if (modeId !== null) changes.push({ kind: 'mode', modeId })
    }
  }
  for (const [configId, choices] of Object.entries(controls?.options ?? {})) {
    const option = findSetting(configOptions, (candidate) => candidate.id === configId)
    if (!option) continue
    const value = pick(choices[policy], settingValues(option), option.value)
    if (value !== null) changes.push({ kind: 'option', configId, value })
  }
  return changes
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

/**
 * The model and effort settings among an agent's session config options. Found by
 * category, since every agent names them differently (`effort`, `reasoning_effort`, …).
 * Null when the agent offers no model choice.
 */
export function parseModelSettings(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): ModelSettings | null {
  const model = selectSetting(configOptions, 'model')
  return model ? { model, effort: selectSetting(configOptions, 'thought_level') } : null
}

function selectSetting(
  configOptions: acp.SessionConfigOption[] | null | undefined,
  category: string,
): AgentSetting | null {
  return findSetting(configOptions, (option) => option.category === category)
}

/** The first select config option `match` accepts, with its choices flattened. */
function findSetting(
  configOptions: acp.SessionConfigOption[] | null | undefined,
  match: (option: Record<string, unknown>) => boolean,
): AgentSetting | null {
  // Custom agents can send anything; a malformed list mustn't break the session.
  if (!Array.isArray(configOptions)) return null
  for (const option of configOptions) {
    if (!isRecord(option) || !match(option) || option.type !== 'select') continue
    if (typeof option.currentValue !== 'string' || !Array.isArray(option.options)) continue
    const entries: unknown[] = option.options
    // Grouped lists (e.g. by provider) are flattened; each choice keeps its group's name.
    const options = entries.flatMap((entry): AgentSetting['options'] => {
      if (isChoice(entry)) return [{ value: entry.value, name: entry.name, group: null }]
      if (!isRecord(entry) || !Array.isArray(entry.options)) return []
      const group = typeof entry.name === 'string' ? entry.name : null
      const choices: unknown[] = entry.options
      return choices.filter(isChoice).map(({ value, name }) => ({ value, name, group }))
    })
    return { id: option.id, value: option.currentValue, options }
  }
  return null
}

const settingValues = (setting: AgentSetting) => setting.options.map(({ value }) => value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isChoice = (value: unknown): value is { value: string; name: string } =>
  isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string'

/** One ACP agent process with a single session rooted at the project. */
export class AgentSession {
  private child: ChildProcess | null = null
  private connection: acp.ClientConnection | null = null
  private sessionId: string | null = null
  private stderr = ''
  private disposed = false
  /** Rejects with the agent's own error output if the process dies. */
  private exited: Promise<never> = new Promise(() => {})
  /** How Ask and Auto set this agent's own permission controls, from its definition */
  private controls: PermissionControls | undefined
  /** The Ask or Auto the session started with (see StartOptions.permissions) */
  private startedWith: PermissionPolicy | undefined
  /** Bookkeeping calls this agent reports (AgentDefinition.hiddenTools), and those seen so far */
  private hiddenTools: RegExp | undefined
  private hiddenCalls = new Set<string>()
  /** The session's settings and modes, as the agent last reported them */
  private configOptions: acp.SessionConfigOption[] = []
  private modes: acp.SessionModeState | null = null

  constructor(
    readonly agentId: AgentId,
    private readonly cwd: string,
    private readonly handlers: AgentHandlers,
  ) {}

  async start({
    mcpServers,
    resumeSessionId,
    authenticate,
    permissions,
  }: StartOptions): Promise<AgentInfo> {
    // Looked up at start, so edits to agents.json apply to the next session.
    const [definition, shellEnv] = await Promise.all([resolveAgent(this.agentId), getShellEnv()])
    if (this.disposed) throw new Error('Agent was stopped')
    this.controls = definition.permissions
    this.startedWith = permissions
    this.hiddenTools = definition.hiddenTools
    const meta = sessionMeta(definition, permissions)
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
      .client({ name: 'gui' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (ctx.params.sessionId !== this.sessionId) return
        const { update } = ctx.params
        if (update.sessionUpdate === 'config_option_update') this.remember(update.configOptions)
        if (update.sessionUpdate === 'current_mode_update') this.rememberMode(update.currentModeId)
        if (this.isHidden(update)) return
        this.handlers.onUpdate(update)
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
          // Gui runs terminal sign-in itself (agent-status.ts); Claude only offers it then.
          auth: { terminal: true },
        },
        clientInfo: { name: 'gui', version: '0.1.0' },
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
    let session: {
      sessionId: string
      modes?: acp.SessionModeState | null
      configOptions?: acp.SessionConfigOption[] | null
    } | null = null
    let resumed = false
    if (resumeSessionId && init.agentCapabilities?.loadSession) {
      const loaded = await this.untilExit(
        agent.request(acp.methods.agent.session.load, {
          sessionId: resumeSessionId,
          cwd: this.cwd,
          mcpServers: servers,
          _meta: meta,
        }),
      ).catch(() => null)
      if (loaded) {
        session = {
          sessionId: resumeSessionId,
          modes: loaded.modes,
          configOptions: loaded.configOptions,
        }
        resumed = true
      }
    }
    session ??= await this.untilExit(
      agent.request(acp.methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers: servers,
        _meta: meta,
      }),
    ).catch((error: unknown) => {
      if (!isAuthError(error)) throw new Error(errorDetail(error))
      // Only offer sign-in flows Gui knows open a browser; others are run in a terminal.
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
    // The session starts in the mode the user's own agent config picks. Gui then sets the
    // agent's own controls to the project's Ask or Auto (`applyPermissions`; Grok's went in
    // `_meta` above) for agents it knows them for (AgentDefinition.permissions); others
    // keep their mode. Gui's rules (ChatController.onPermission) answer what still asks.
    this.modes = session.modes ?? null
    this.remember(session.configOptions)
    this.sessionId = session.sessionId

    return {
      sessionId: session.sessionId,
      resumed,
      supportsImages: init.agentCapabilities?.promptCapabilities?.image === true,
      previewTools: servers.length > 0,
      modeName: this.modeName,
      models: this.models,
    }
  }

  /** The session's mode, by name: its `mode` config option's, else its ACP session mode's. */
  get modeName(): string | null {
    const option = selectSetting(this.configOptions, 'mode')
    if (option) {
      const current = option.options.find(({ value }) => value === option.value)
      return current?.name ?? option.value
    }
    const modes = this.modes
    if (!modes) return null
    const listed = Array.isArray(modes.availableModes) ? modes.availableModes : []
    return listed.find((mode) => mode.id === modes.currentModeId)?.name ?? modes.currentModeId
  }

  /** The session's model and effort settings, as the agent last reported them. */
  get models(): ModelSettings | null {
    return parseModelSettings(this.configOptions)
  }

  /**
   * Ask or Auto changed for an agent that only takes it as a session starts (Grok), so
   * the session has to be started again (resumed) to follow it.
   */
  restartsFor(policy: PermissionPolicy) {
    return this.controls?.sessionMeta !== undefined && this.startedWith !== policy
  }

  /**
   * Sets the agent's own permission controls for Ask or Auto (see `permissionChanges`).
   * Every change is tried; returns why each one the agent refused failed.
   */
  async applyPermissions(policy: PermissionPolicy): Promise<string[]> {
    const { connection, sessionId } = this
    if (!connection || !sessionId) throw new Error('Agent is not running')
    const failures: string[] = []
    const changes = permissionChanges(this.controls, policy, this.configOptions, this.modes)
    for (const change of changes) {
      try {
        if (change.kind === 'mode') {
          await this.untilExit(
            connection.agent.request(acp.methods.agent.session.setMode, {
              sessionId,
              modeId: change.modeId,
            }),
          )
          this.rememberMode(change.modeId)
        } else {
          const response = await this.untilExit(
            connection.agent.request(acp.methods.agent.session.setConfigOption, {
              sessionId,
              configId: change.configId,
              value: change.value,
            }),
          )
          this.remember(response.configOptions)
        }
      } catch (error) {
        failures.push(errorDetail(error))
      }
    }
    return failures
  }

  async prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const { connection, sessionId } = this
    if (!connection || !sessionId) throw new Error('Agent is not running')
    return this.untilExit(
      connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: blocks }),
    )
  }

  /** Changes one of the session's settings; returns its model settings as they now stand. */
  async setConfigOption(configId: string, value: string): Promise<ModelSettings | null> {
    const { connection, sessionId } = this
    if (!connection || !sessionId) throw new Error('Agent is not running')
    const response = await this.untilExit(
      connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
      }),
    )
    this.remember(response.configOptions)
    return this.models
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

  /**
   * Keeps the settings the agent reported. Agents that offer the mode both ways should
   * keep the two in step, but may report a change through only one of them.
   */
  private remember(configOptions: acp.SessionConfigOption[] | null | undefined) {
    this.configOptions = Array.isArray(configOptions) ? configOptions : []
    const mode = selectSetting(this.configOptions, 'mode')
    if (mode && this.modes) this.modes = { ...this.modes, currentModeId: mode.value }
  }

  /** A bookkeeping call the definition hides (AgentDefinition.hiddenTools), or an update to one. */
  private isHidden(update: acp.SessionNotification['update']) {
    if (update.sessionUpdate === 'tool_call_update') return this.hiddenCalls.has(update.toolCallId)
    if (update.sessionUpdate !== 'tool_call' || !this.hiddenTools) return false
    const hidden = (update.kind ?? 'other') === 'other' && this.hiddenTools.test(update.title)
    if (hidden) this.hiddenCalls.add(update.toolCallId)
    return hidden
  }

  private rememberMode(modeId: string) {
    const listed = this.modes?.availableModes
    this.modes = { availableModes: Array.isArray(listed) ? listed : [], currentModeId: modeId }
    this.configOptions = this.configOptions.map((option) =>
      option.category === 'mode' && option.type === 'select'
        ? { ...option, currentValue: modeId }
        : option,
    )
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
