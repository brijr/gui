import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { AGENTS, type AgentHealth, type AgentId } from '../shared/types'
import { AgentAuthError, AgentSession, type AuthMethod } from './agent'
import {
  agentBinary,
  forgetBinaries,
  type InstallProgress,
  installAgentBinary,
  missingMessage,
  type PinnedAgentId,
  pinnedAgent,
  requireAgentBinary,
} from './agent-binaries'
import { type AgentDefinition, listAgents } from './agents'
import { describeError } from './errors'
import { getPrefs, isAgentEnabled, prefsEvents } from './prefs'
import { getShellEnv } from './shell-env'
import { runInTerminal } from './terminal'

const CHECK_TIMEOUT_MS = 45_000
/** Browser sign-in waits on the user. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Browser-based sign-in methods Grat can drive; API keys belong in the user's environment. */
const SIGN_IN_METHODS = [
  'claude-ai-login',
  'chat-gpt',
  'chatgpt',
  'browser',
  'oauth',
  'claude-ai',
  'login',
]
/** Marks a sign-in Grat starts in Terminal rather than through the agent. */
const TERMINAL_SIGN_IN = 'grat:terminal'
/** Agents whose CLI Grat pins and can install; checked on every launch. */
const PINNED: readonly AgentId[] = ['claude', 'codex']
/** Download progress is pushed to every window; a 100 MB download has thousands of chunks. */
const PROGRESS_INTERVAL_MS = 150

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

function killGroup(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
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
  install: null,
  progress: null,
  binary: null,
})

/**
 * Every agent Grat knows (built in and from agents.json), whether it's installed, and
 * whether it can start a session, checked by actually starting one in an empty folder.
 * No prompt is sent, so checking costs no usage. Also sets agents up: downloads Claude
 * Code or Codex when missing, and runs sign-in.
 */
class AgentHealthStore extends EventEmitter<{ change: [health: AgentHealth[]] }> {
  private health = new Map<AgentId, AgentHealth>(
    AGENTS.map((agent) => [
      agent.id,
      unchecked({ ...agent, command: null, installUrl: null }, true),
    ]),
  )
  private running = new Map<AgentId, Promise<void>>()
  /** Sign-in methods the agent offered when it said the user isn't signed in */
  private methods = new Map<AgentId, AuthMethod>()
  /** Scans run one after another, so one asked for after a change sees that change. */
  private scans: Promise<void> = Promise.resolve()
  /** Why agents.json couldn't be read, if it couldn't */
  customError: string | null = null
  /** Probe processes still alive; detached, so they'd outlive the app if not stopped. */
  private sessions = new Set<AgentSession>()
  private signIns = new Set<ChildProcess>()
  private downloads = new Set<AbortController>()
  private lastProgress = new Map<AgentId, number>()
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
   * Checks every installed agent, including whether the user installed or updated a
   * pinned CLI. Starting a session leaves an empty one in some agents' own history, so
   * this runs when the user asks rather than on every launch.
   */
  async checkAll() {
    if (this.disposed) return
    forgetBinaries()
    await this.rescan()
    await Promise.all(
      this.list()
        .filter((agent) => agent.enabled && this.checkable(agent))
        .map((agent) => this.check(agent.id)),
    )
  }

  /** On launch: Claude Code, Codex, and the one the user picked, when they're enabled. */
  async checkOnLaunch(preferred: AgentId) {
    if (this.disposed) return
    const targets = [...new Set([...PINNED, preferred])]
    // Finding what's installed takes a moment; say it's being checked rather than not.
    for (const id of targets) {
      if (this.health.get(id)?.status === 'unknown') this.set(id, { status: 'checking' })
    }
    await this.rescan()
    const ids = targets.filter((id) => {
      const agent = this.health.get(id)
      return agent?.enabled && this.checkable(agent)
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
    return this.exclusive(id, () => this.probe(id, undefined))
  }

  /**
   * Claude Code and Codex: downloads the CLI into Grat's data folder, then checks it
   * (usually: sign in next). Other agents: opens their official install page.
   */
  install(id: AgentId) {
    const pinned = pinnedAgent(id)
    if (!pinned) {
      const url = this.health.get(id)?.installUrl
      if (url?.startsWith('https://')) void shell.openExternal(url)
      return Promise.resolve()
    }
    if (this.disposed || !this.health.get(id)?.install) return Promise.resolve()
    return this.exclusive(id, async () => {
      const download = new AbortController()
      this.downloads.add(download)
      this.set(id, {
        status: 'installing',
        message: null,
        detail: null,
        progress: { received: 0, total: null },
      })
      try {
        await installAgentBinary(
          pinned,
          (progress) => this.setProgress(id, progress),
          download.signal,
        )
      } catch (error) {
        if (!download.signal.aborted) {
          const { message, detail } = describeError(error)
          this.set(id, { status: 'error', progress: null, message, detail })
        }
        return
      } finally {
        this.downloads.delete(download)
      }
      this.set(id, { progress: null })
      await this.probe(id, undefined)
    })
  }

  /** Runs the agent's own sign-in flow (usually opens the browser), then re-checks. */
  signIn(id: AgentId) {
    const methodId = this.health.get(id)?.signIn?.methodId
    if (!methodId || this.disposed) return Promise.resolve()
    if (methodId === TERMINAL_SIGN_IN) return this.signInInTerminal(id)
    const method = this.methods.get(id)
    const pinned = pinnedAgent(id)
    return this.exclusive(id, async () => {
      if (!method?.terminalArgs || !pinned) {
        await this.probe(id, methodId)
        return
      }
      this.set(id, {
        status: 'signing-in',
        message: 'Finish signing in in your browser…',
        detail: null,
      })
      try {
        await this.runSignIn(pinned, method.terminalArgs)
      } catch (error) {
        const { message, detail } = describeError(error)
        this.set(id, { status: 'signed-out', message, detail })
        return
      }
      await this.probe(id, undefined)
    })
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
    for (const id of await this.newlyInstalled()) ids.add(id)
    await Promise.all([...ids].map((id) => this.check(id)))
  }

  /**
   * Claude Code or Codex shown as missing that the user has since installed (or updated)
   * themselves. Only looks for the CLI, without a visible "Checking", so focusing Grat
   * doesn't flicker every missing agent.
   */
  private async newlyInstalled() {
    const found: AgentId[] = []
    for (const agent of this.list()) {
      const pinned = pinnedAgent(agent.id)
      if (!pinned || !agent.enabled || agent.status !== 'not-installed') continue
      if (this.running.has(agent.id)) continue
      forgetBinaries(pinned)
      const binary = await agentBinary(pinned).catch(() => null)
      if (binary?.kind === 'ready') found.push(agent.id)
    }
    return found
  }

  /** Stops every check, download and sign-in in progress (a sign-in would outlive Grat). */
  dispose() {
    this.disposed = true
    for (const session of this.sessions) session.dispose()
    this.sessions.clear()
    for (const child of this.signIns) killGroup(child)
    this.signIns.clear()
    for (const download of this.downloads) download.abort()
    this.downloads.clear()
  }

  /**
   * Claude Code and Codex are always worth checking (a missing CLI is installable);
   * other agents only once their CLI is on PATH.
   */
  private checkable(agent: AgentHealth) {
    return agent.status !== 'not-installed' || pinnedAgent(agent.id) !== null
  }

  /** One operation per agent at a time; a second request joins the one in progress. */
  private exclusive(id: AgentId, run: () => Promise<void>) {
    const pending = this.running.get(id)
    if (pending) return pending
    const task = run().finally(() => this.running.delete(id))
    this.running.set(id, task)
    return task
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

  /**
   * Terminal sign-in an agent offers over ACP: the adapter's `--cli <args>` hands the
   * arguments to its CLI, so run that CLI directly. It opens the browser and exits 0
   * once the user has signed in.
   */
  private async runSignIn(id: PinnedAgentId, args: string[]) {
    const binary = await requireAgentBinary(id)
    const env = await getShellEnv()
    if (this.disposed) return
    const child = spawn(binary.path, args[0] === '--cli' ? args.slice(1) : args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    this.signIns.add(child)
    let output = ''
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-2000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code) => {
            const detail = output.trim().split('\n').at(-1)
            if (code === 0) resolve()
            else reject(new Error(detail ? `Sign-in didn't finish: ${detail}` : 'Sign-in failed.'))
          })
        }),
        SIGN_IN_TIMEOUT_MS,
        'Sign-in timed out.',
      )
    } finally {
      this.signIns.delete(child)
      killGroup(child)
    }
  }

  private async scan() {
    const { agents, customError } = await listAgents()
    const next = new Map<AgentId, AgentHealth>()
    for (const { installed, terminalSignIn, ...agent } of agents) {
      if (terminalSignIn) this.terminalSignIns.set(agent.id, terminalSignIn)
      else this.terminalSignIns.delete(agent.id)
      const current = this.health.get(agent.id)
      // A pinned agent whose CLI is missing stays as its last check left it (with Install).
      const keep =
        current && installed && (current.status !== 'not-installed' || current.install !== null)
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
    const pinned = pinnedAgent(id)
    if (!pinned && this.health.get(id)?.status === 'not-installed') return
    this.set(id, {
      status: authenticate ? 'signing-in' : 'checking',
      message: authenticate ? 'Finish signing in in your browser…' : null,
      detail: null,
    })
    if (pinned) {
      try {
        const binary = await agentBinary(pinned)
        if (binary.kind === 'missing') {
          this.methods.delete(id)
          this.set(id, {
            status: 'not-installed',
            message: missingMessage(pinned, binary),
            install: binary.found ? 'update' : 'install',
            signIn: null,
            binary: null,
          })
          return
        }
        this.set(id, {
          install: null,
          binary: { source: binary.binary.source, version: binary.binary.version },
        })
      } catch (error) {
        const { message, detail } = describeError(error)
        this.set(id, { status: 'error', message, detail })
        return
      }
    }

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
      this.methods.delete(id)
      this.set(id, { status: 'ready', message: null, detail: null, signIn: null })
    } catch (error) {
      if (error instanceof AgentAuthError) {
        const method =
          error.methods.find((m) => SIGN_IN_METHODS.includes(m.id.toLowerCase())) ??
          error.methods.find((m) => !/api.?key/i.test(m.id))
        if (method) this.methods.set(id, method)
        else this.methods.delete(id)
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

  private setProgress(id: AgentId, progress: InstallProgress) {
    const now = Date.now()
    const done = progress.total !== null && progress.received >= progress.total
    if (!done && now - (this.lastProgress.get(id) ?? 0) < PROGRESS_INTERVAL_MS) return
    this.lastProgress.set(id, now)
    this.set(id, { progress })
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
