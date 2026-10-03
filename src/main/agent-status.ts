import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { AGENTS, type AgentHealth, type AgentId } from '../shared/types'
import { AgentAuthError, AgentSession } from './agent'

const CHECK_TIMEOUT_MS = 45_000
/** Browser sign-in waits on the user. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Browser-based sign-in methods Grat can drive; API keys belong in the user's environment. */
const SIGN_IN_METHODS = ['chat-gpt', 'chatgpt', 'browser', 'oauth', 'claude-ai', 'login']

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

/**
 * Whether each agent can start a session, checked by actually starting one in an
 * empty folder. No prompt is sent, so checking costs no usage.
 */
class AgentHealthStore extends EventEmitter<{ change: [health: AgentHealth[]] }> {
  private health = new Map<AgentId, AgentHealth>(
    AGENTS.map((agent) => [
      agent.id,
      { id: agent.id, status: 'unknown', message: null, signIn: null },
    ]),
  )
  private running = new Map<AgentId, Promise<void>>()

  list(): AgentHealth[] {
    return AGENTS.map((agent) => this.health.get(agent.id) as AgentHealth)
  }

  checkAll() {
    for (const agent of AGENTS) void this.check(agent.id)
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

  private async probe(id: AgentId, authenticate: string | undefined) {
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
