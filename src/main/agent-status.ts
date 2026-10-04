import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { AGENTS, type AgentHealth, type AgentId } from '../shared/types'
import { AgentAuthError, AgentSession } from './agent'
import { listAgents } from './agents'
import { isAgentEnabled, prefsEvents } from './prefs'

const CHECK_TIMEOUT_MS = 45_000
/** Browser sign-in waits on the user. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Browser-based sign-in methods Grat can drive; API keys belong in the user's environment. */
const SIGN_IN_METHODS = ['chat-gpt', 'chatgpt', 'browser', 'oauth', 'claude-ai', 'login']
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
  agent: Pick<AgentHealth, 'id' | 'name' | 'command'>,
  installed: boolean,
): AgentHealth => ({
  ...agent,
  enabled: isAgentEnabled(agent.id),
  status: installed ? 'unknown' : 'not-installed',
  message: null,
  signIn: null,
})

/**
 * Every agent Grat knows (built in and from agents.json), whether it's installed, and
 * whether it can start a session, checked by actually starting one in an empty folder.
 * No prompt is sent, so checking costs no usage.
 */
class AgentHealthStore extends EventEmitter<{ change: [health: AgentHealth[]] }> {
  private health = new Map<AgentId, AgentHealth>(
    AGENTS.map((agent) => [agent.id, unchecked({ ...agent, command: null }, true)]),
  )
  private running = new Map<AgentId, Promise<void>>()
  /** Scans run one after another, so one asked for after a change sees that change. */
  private scans: Promise<void> = Promise.resolve()
  /** Why agents.json couldn't be read, if it couldn't */
  customError: string | null = null

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
    await this.rescan()
    await Promise.all(
      this.list()
        .filter((agent) => agent.enabled && agent.status !== 'not-installed')
        .map((agent) => this.check(agent.id)),
    )
  }

  /** On launch: the bundled agents plus the one the user picked, when they're enabled. */
  async checkOnLaunch(preferred: AgentId) {
    await this.rescan()
    const ids = [...new Set([...BUNDLED, preferred])].filter((id) => {
      const agent = this.health.get(id)
      return agent?.enabled && agent.status !== 'not-installed'
    })
    await Promise.all(ids.map((id) => this.check(id)))
  }

  check(id: AgentId) {
    const pending = this.running.get(id)
    if (pending) return pending
    const run = this.probe(id, undefined).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  /** Runs the agent's own sign-in flow (usually opens the browser), then re-checks. */
  async signIn(id: AgentId) {
    const method = this.health.get(id)?.signIn?.methodId
    if (!method) return
    await this.running.get(id)
    const run = this.probe(id, method).finally(() => this.running.delete(id))
    this.running.set(id, run)
    await run
  }

  private async scan() {
    const { agents, customError } = await listAgents()
    const next = new Map<AgentId, AgentHealth>()
    for (const { installed, ...agent } of agents) {
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
    })
    const dir = join(app.getPath('userData'), 'agent-check')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const session = new AgentSession(id, dir, noopHandlers)
    try {
      await withTimeout(
        session.start({ mcpServers: [], authenticate }),
        authenticate ? SIGN_IN_TIMEOUT_MS : CHECK_TIMEOUT_MS,
        authenticate ? 'Sign-in timed out.' : "The agent didn't respond. Try again.",
      )
      this.set(id, { status: 'ready', message: null, signIn: null })
    } catch (error) {
      if (error instanceof AgentAuthError) {
        const method =
          error.methods.find((m) => SIGN_IN_METHODS.includes(m.id.toLowerCase())) ??
          error.methods.find((m) => !/api.?key/i.test(m.id))
        this.set(id, {
          status: 'signed-out',
          message: error.message,
          signIn: method ? { methodId: method.id, label: `Sign in with ${method.name}` } : null,
        })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.set(id, { status: 'error', message, signIn: this.health.get(id)?.signIn ?? null })
      }
    } finally {
      session.dispose()
    }
  }

  private set(id: AgentId, patch: Partial<AgentHealth>) {
    const current = this.health.get(id)
    if (!current) return
    this.health.set(id, { ...current, ...patch })
    this.emit('change', this.list())
  }
}

export const agentHealth = new AgentHealthStore()
