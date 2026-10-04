import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { AGENTS, type AgentHealth, type AgentId } from '../shared/types'
import { AgentAuthError, AgentSession, type AuthMethod } from './agent'
import {
  agentBinary,
  forgetBinaries,
  type InstallProgress,
  installAgentBinary,
  missingMessage,
  requireAgentBinary,
} from './agent-binaries'
import { getShellEnv } from './shell-env'

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
/** Download progress is pushed to every window; a 100 MB download has thousands of chunks. */
const PROGRESS_INTERVAL_MS = 150

const noopHandlers = {
  onUpdate: () => undefined,
  onPermission: (_request: unknown, resolve: (optionId: string | null) => void) => resolve(null),
  onExit: () => undefined,
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

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

/**
 * Whether each agent can start a session, checked by actually starting one in an
 * empty folder. No prompt is sent, so checking costs no usage. Also sets agents up:
 * downloads a missing CLI and runs its sign-in.
 */
class AgentHealthStore extends EventEmitter<{ change: [health: AgentHealth[]] }> {
  private health = new Map<AgentId, AgentHealth>(
    AGENTS.map((agent) => [
      agent.id,
      {
        id: agent.id,
        status: 'unknown',
        message: null,
        signIn: null,
        install: null,
        progress: null,
        binary: null,
      },
    ]),
  )
  private running = new Map<AgentId, Promise<void>>()
  private methods = new Map<AgentId, AuthMethod>()
  /** Probe processes still alive; detached, so they'd outlive the app if not stopped. */
  private sessions = new Set<AgentSession>()
  private signIns = new Set<ChildProcess>()
  private downloads = new Set<AbortController>()
  private lastProgress = new Map<AgentId, number>()
  private disposed = false

  list(): AgentHealth[] {
    return AGENTS.map((agent) => this.health.get(agent.id) as AgentHealth)
  }

  /** Re-checks every agent, including whether the user installed or updated a CLI. */
  checkAll() {
    if (this.disposed) return
    for (const agent of AGENTS) {
      if (this.running.has(agent.id)) continue
      forgetBinaries(agent.id)
      void this.check(agent.id)
    }
  }

  check(id: AgentId) {
    if (this.disposed) return Promise.resolve()
    return this.exclusive(id, () => this.probe(id, undefined))
  }

  /** Downloads the agent's CLI into Grat's data folder, then checks it (usually: sign in next). */
  install(id: AgentId) {
    if (this.disposed || !this.health.get(id)?.install) return Promise.resolve()
    return this.exclusive(id, async () => {
      const download = new AbortController()
      this.downloads.add(download)
      this.set(id, { status: 'installing', message: null, progress: { received: 0, total: null } })
      try {
        await installAgentBinary(id, (progress) => this.setProgress(id, progress), download.signal)
      } catch (error) {
        if (!download.signal.aborted) {
          this.set(id, { status: 'error', progress: null, message: errorMessage(error) })
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
    const method = this.methods.get(id)
    if (!method || this.disposed) return Promise.resolve()
    return this.exclusive(id, async () => {
      if (!method.terminalArgs) {
        await this.probe(id, method.id)
        return
      }
      this.set(id, { status: 'signing-in', message: 'Finish signing in in your browser…' })
      try {
        await this.runSignIn(id, method.terminalArgs)
      } catch (error) {
        this.set(id, { status: 'signed-out', message: errorMessage(error) })
        return
      }
      await this.probe(id, undefined)
    })
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

  /** One operation per agent at a time; a second request joins the one in progress. */
  private exclusive(id: AgentId, run: () => Promise<void>) {
    const pending = this.running.get(id)
    if (pending) return pending
    const task = run().finally(() => this.running.delete(id))
    this.running.set(id, task)
    return task
  }

  private async probe(id: AgentId, authenticate: string | undefined) {
    this.set(id, {
      status: authenticate ? 'signing-in' : 'checking',
      message: authenticate ? 'Finish signing in in your browser…' : null,
    })
    try {
      const binary = await agentBinary(id)
      if (binary.kind === 'missing') {
        this.methods.delete(id)
        this.set(id, {
          status: 'not-installed',
          message: missingMessage(id, binary),
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
      this.set(id, { status: 'error', message: errorMessage(error) })
      return
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
      this.set(id, { status: 'ready', message: null, signIn: null })
    } catch (error) {
      if (error instanceof AgentAuthError) {
        const method =
          error.methods.find((m) => SIGN_IN_METHODS.includes(m.id.toLowerCase())) ??
          error.methods.find((m) => !/api.?key/i.test(m.id))
        if (method) this.methods.set(id, method)
        else this.methods.delete(id)
        this.set(id, {
          status: 'signed-out',
          message: error.message,
          signIn: method ? { methodId: method.id, label: `Sign in with ${method.name}` } : null,
        })
      } else {
        this.set(id, { status: 'error', message: errorMessage(error) })
      }
    } finally {
      this.sessions.delete(session)
      session.dispose()
    }
  }

  /**
   * Terminal sign-in: the adapter's `--cli <args>` hands the arguments to its CLI, so run
   * that CLI directly. It opens the browser and exits 0 once the user has signed in.
   */
  private async runSignIn(id: AgentId, args: string[]) {
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
