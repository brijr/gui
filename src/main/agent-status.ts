import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { AGENTS, type AgentHealth, type AgentId } from '../shared/types'
import { AgentAuthError, AgentSession } from './agent'
import { type AgentDefinition, listAgents } from './agents'
import { describeError } from './errors'
import { getPrefs, isAgentEnabled, prefsEvents } from './prefs'
import { runInTerminal } from './terminal'

const CHECK_TIMEOUT_MS = 45_000
/** Browser sign-in waits on the user. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Browser-based sign-in methods Grat can drive; API keys belong in the user's environment. */
const SIGN_IN_METHODS = ['chat-gpt', 'chatgpt', 'browser', 'oauth', 'claude-ai', 'login']
/** Marks a sign-in Grat starts in Terminal rather than through the agent. */
const TERMINAL_SIGN_IN = 'grat:terminal'
/** Agents Grat bundles; checked on every launch since they're always there. */
const BUNDLED: readonly AgentId[] = ['claude', 'codex']

const noopHandlers = {
  onUpdate: () => undefined,
  onPermission: (_request: unknown, resolve: (optionId: string | null) => void) => resolve(null),
  onExit: () => undefined,
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const unchecked = (
  agent: Pick<AgentHealth, 'id' | 'name' | 'command' | 'installUrl'>,
  installed: boolean,
): AgentHealth => ({
  ...agent,
  enabled: isAgentEnabled(agent.id),
  status: installed ? 'unknown' : 'not-installed',
  message: null,
  detail: null,
  signIn: null,
})

/**
 * Every agent Grat knows (built in and from agents.json), whether it's installed, and
 * whether it can start a session, checked by actually starting one in an empty folder.
 * No prompt is sent, so checking costs no usage.
 */
class AgentHealthStore extends EventEmitter<{ change: [health: AgentHealth[]] }> {
  private health = new Map<AgentId, AgentHealth>(
    AGENTS.map((agent) => [
      agent.id,
      unchecked({ ...agent, command: null, installUrl: null }, true),
    ]),
  )
  private running = new Map<AgentId, Promise<void>>()
  /** Scans run one after another, so one asked for after a change sees that change. */
  private scans: Promise<void> = Promise.resolve()
  /** Why agents.json couldn't be read, if it couldn't */
  customError: string | null = null
  /** Probe processes still alive; detached, so they'd outlive the app if not stopped. */
  private sessions = new Set<AgentSession>()
  private disposed = false
  /** Agents whose sign-in can run in Terminal, from the catalog */
  private terminalSignIns = new Map<AgentId, NonNullable<AgentDefinition['terminalSignIn']>>()
  /** Signing in in Terminal right now; checked again when the user comes back to Grat */
  private awaitingTerminal = new Set<AgentId>()

  constructor() {
    super()
    prefsEvents.on('change', () => this.syncEnabled())
  }

  list(): AgentHealth[] {
    return [...this.health.values()]
  }

  has(id: AgentId) {
    return this.health.has(id)
  }

  /** Re-reads agents.json and which CLIs are on PATH, without starting any agent. */
  rescan() {
    this.scans = this.scans.then(() => this.scan()).catch(() => undefined)
    return this.scans
  }

  /**
   * Checks every installed agent. Starting a session leaves an empty one in some agents'
   * own history, so this runs when the user asks rather than on every launch.
   */
  async checkAll() {
    if (this.disposed) return
    await this.rescan()
    await Promise.all(
      this.list()
        .filter((agent) => agent.enabled && agent.status !== 'not-installed')
        .map((agent) => this.check(agent.id)),
    )
  }

  /** On launch: the bundled agents plus the one the user picked, when they're enabled. */
  async checkOnLaunch(preferred: AgentId) {
    if (this.disposed) return
    const targets = [...new Set([...BUNDLED, preferred])]
    // Finding what's installed takes a moment; say it's being checked rather than not.
    for (const id of targets) {
      if (this.health.get(id)?.status === 'unknown') this.set(id, { status: 'checking' })
    }
    await this.rescan()
    const ids = targets.filter((id) => {
      const agent = this.health.get(id)
      return agent?.enabled && agent.status !== 'not-installed'
    })
    await Promise.all(ids.map((id) => this.check(id)))
  }

  /** Checks an agent the user just picked, unless its state is already known. */
  ensureChecked(id: AgentId) {
    const agent = this.health.get(id)
    if (agent?.enabled && agent.status === 'unknown') void this.check(id)
  }

  check(id: AgentId) {
    if (this.disposed) return Promise.resolve()
    const pending = this.running.get(id)
    if (pending) return pending
    const run = this.probe(id, undefined).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  /** Runs the agent's own sign-in flow (usually opens the browser), then re-checks. */
  async signIn(id: AgentId) {
    const method = this.health.get(id)?.signIn?.methodId
    if (!method || this.disposed) return
    if (method === TERMINAL_SIGN_IN) return this.signInInTerminal(id)
    await this.running.get(id)
    const run = this.probe(id, method).finally(() => this.running.delete(id))
    this.running.set(id, run)
    await run
  }

  /** Opens the agent's official install page. */
  openInstallPage(id: AgentId) {
    const url = this.health.get(id)?.installUrl
    if (url?.startsWith('https://')) void shell.openExternal(url)
  }

  /**
   * The user came back to Grat: pick up agents installed meanwhile, and re-check ones
   * they were signing in to in Terminal (and the default agent, if it's new here).
   */
  async onAppFocus() {
    if (this.disposed) return
    await this.rescan()
    const ids = new Set(this.awaitingTerminal)
    this.awaitingTerminal.clear()
    const preferred = this.health.get(getPrefs().agentId)
    if (preferred?.enabled && preferred.status === 'unknown') ids.add(preferred.id)
    await Promise.all([...ids].map((id) => this.check(id)))
  }

  private async signInInTerminal(id: AgentId) {
    const agent = this.health.get(id)
    const login = this.terminalSignIns.get(id)
    if (!agent || !login) return
    await runInTerminal(login.command, `Signing in to ${agent.name}. ${login.hint}`)
    this.awaitingTerminal.add(id)
    this.set(id, {
      status: 'signing-in',
      message: 'Finish signing in in Terminal, then come back to Grat.',
      detail: null,
    })
  }

  private async scan() {
    const { agents, customError } = await listAgents()
    const next = new Map<AgentId, AgentHealth>()
    for (const { installed, terminalSignIn, ...agent } of agents) {
      if (terminalSignIn) this.terminalSignIns.set(agent.id, terminalSignIn)
      else this.terminalSignIns.delete(agent.id)
      const current = this.health.get(agent.id)
      const keep = current && installed && current.status !== 'not-installed'
      next.set(
        agent.id,
        keep
          ? { ...current, ...agent, enabled: isAgentEnabled(agent.id) }
          : unchecked(agent, installed),
      )
    }
    const changed =
      customError !== this.customError ||
      JSON.stringify([...next.values()]) !== JSON.stringify(this.list())
    this.health = next
    this.customError = customError
    if (changed) this.emit('change', this.list())
  }

  /** Applies Settings' on/off switches; a newly enabled agent gets checked right away. */
  private syncEnabled() {
    let changed = false
    for (const [id, agent] of this.health) {
      const enabled = isAgentEnabled(id)
      if (agent.enabled === enabled) continue
      changed = true
      this.health.set(id, { ...agent, enabled })
      if (enabled && agent.status === 'unknown') void this.check(id)
    }
    if (changed) this.emit('change', this.list())
  }

  private async probe(id: AgentId, authenticate: string | undefined) {
    if (this.health.get(id)?.status === 'not-installed') return
    this.set(id, {
      status: authenticate ? 'signing-in' : 'checking',
      message: authenticate ? 'Finish signing in in your browser…' : null,
      detail: null,
    })
    const dir = join(app.getPath('userData'), 'agent-check')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (this.disposed) return
    const session = new AgentSession(id, dir, noopHandlers)
    this.sessions.add(session)
    try {
      await withTimeout(
        session.start({ mcpServers: [], authenticate }),
        authenticate ? SIGN_IN_TIMEOUT_MS : CHECK_TIMEOUT_MS,
        authenticate ? 'Sign-in timed out.' : "The agent didn't respond. Try again.",
      )
      this.set(id, { status: 'ready', message: null, detail: null, signIn: null })
    } catch (error) {
      if (error instanceof AgentAuthError) {
        const method =
          error.methods.find((m) => SIGN_IN_METHODS.includes(m.id.toLowerCase())) ??
          error.methods.find((m) => !/api.?key/i.test(m.id))
        const signIn = method
          ? { methodId: method.id, label: `Sign in with ${method.name}` }
          : this.terminalSignIns.has(id)
            ? { methodId: TERMINAL_SIGN_IN, label: 'Sign in' }
            : null
        this.set(id, { status: 'signed-out', message: error.message, detail: null, signIn })
      } else {
        const { message, detail } = describeError(error)
        this.set(id, {
          status: 'error',
          message,
          detail,
          signIn: this.health.get(id)?.signIn ?? null,
        })
      }
    } finally {
      this.sessions.delete(session)
      session.dispose()
    }
  }

  /** Stops every check and sign-in in progress (a Codex sign-in would otherwise outlive Grat). */
  dispose() {
    this.disposed = true
    for (const session of this.sessions) session.dispose()
    this.sessions.clear()
  }

  private set(id: AgentId, patch: Partial<AgentHealth>) {
    if (this.disposed) return
    const current = this.health.get(id)
    if (!current) return
    this.health.set(id, { ...current, ...patch })
    this.emit('change', this.list())
  }
}

export const agentHealth = new AgentHealthStore()
