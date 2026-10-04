import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Problem } from '../shared/types'

const MAX_MESSAGES = 100
const MAX_SERVER_ERRORS = 20
const MAX_TEXT = 2000
/** A burst of errors becomes one update instead of one IPC push (and layout pass) each. */
const CHANGE_THROTTLE_MS = 200

/** Dev server output that means compilation or a request failed. */
const SERVER_ERROR =
  /\b(error|failed to (compile|resolve|load)|cannot find module|unexpected token|syntaxerror|typeerror|referenceerror)\b|⨯|✘/i
const NOT_AN_ERROR = /\b0 errors?\b|\bno errors?\b|error_reporting|errorBoundary/i
/** `at fn (file:line)` lines belong to the error above them, not a new error. */
const STACK_FRAME = /^\s*at\s+\S/
/** Output that means the dev server recovered (a successful rebuild or hot update). */
const SERVER_RECOVERED = /\bhmr update\b|\bpage reload\b|\bcompiled\b|\bready in\b|✓/i
/** Next.js (webpack and Turbopack) announces a hot update before applying it. */
const HMR_STARTED = /^\[Fast Refresh\] rebuilding\b/
/**
 * Browser-side hot update applied without a full reload: Vite logs this via
 * console.debug, Next.js via console.log. Anything logged before it is stale.
 */
const HMR_APPLIED = /^\[Fast Refresh\] done\b|^\[vite\] hot updated:/
/**
 * What a dev server or the browser puts in front of an error's own text: a timestamp,
 * Vite's `[vite] (client) [Unhandled error]` when it re-logs a browser error, the
 * browser's `Uncaught (in promise)`.
 */
const ERROR_PREFIXES = [
  /^\d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?\s+/i,
  /^\[vite\]\s*(?:\(client\)\s*)?(?:\[[^\]]+\]\s*)?/i,
  /^Uncaught\s+(?:\(in promise\)\s+)?/i,
]

/** An error's first line without its prefixes: the same error reads the same wherever it's logged. */
function errorKey(message: string) {
  let key = message.split('\n', 1)[0]?.trim() ?? ''
  for (const prefix of ERROR_PREFIXES) key = key.replace(prefix, '')
  return key
}

/**
 * One problem per error. Vite re-logs an uncaught browser error on the dev server, and
 * pages can log one error more than once; the browser's own report wins, keeping the
 * place of the first.
 */
function distinct(problems: Problem[]) {
  const byKey = new Map<string, Problem>()
  for (const problem of problems) {
    const key = errorKey(problem.message)
    const seen = byKey.get(key)
    if (!seen) byKey.set(key, problem)
    else if (seen.source === 'server' && problem.source === 'console') byKey.set(key, problem)
  }
  return [...byKey.values()]
}

export interface ConsoleEntry {
  level: 'warning' | 'error'
  message: string
  source: string
  at: number
}

/**
 * What's currently wrong with the previewed app: console errors since the last
 * navigation or hot update, and dev-server errors since its last successful rebuild.
 */
export class Problems extends EventEmitter<{ change: [problems: Problem[]] }> {
  private messages: ConsoleEntry[] = []
  private serverErrors: Problem[] = []
  /** Strictly increasing console timestamps, so ordering against an HMR mark is exact. */
  private clock = 0
  /** When the hot update in progress started; errors after it come from the new code. */
  private hmrStart: number | null = null
  private emitTimer: NodeJS.Timeout | null = null
  /** Problem ids last emitted, to skip updates that change nothing. */
  private emittedIds = ''

  /** Current errors, each once, newest last. */
  list(): Problem[] {
    const consoleErrors = this.messages
      .filter((m) => m.level === 'error')
      .map(
        (m): Problem => ({
          id: `${m.at}:${m.message.slice(0, 40)}`,
          source: 'console',
          message: m.source ? `${m.message}\n    at ${m.source}` : m.message,
          at: m.at,
        }),
      )
    const all = [...consoleErrors, ...this.serverErrors].sort((a, b) => a.at - b.at)
    return distinct(all).slice(-10)
  }

  /** Recent console warnings and errors, for the agent's console tool. */
  recentConsole() {
    return this.messages.slice()
  }

  addConsole(level: 'info' | 'warning' | 'error' | 'debug', message: string, source: string) {
    // HMR clients log at info/debug, so check before dropping those levels.
    if (HMR_STARTED.test(message)) {
      this.hmrStart = this.tick()
      return
    }
    if (HMR_APPLIED.test(message)) {
      this.clearConsoleErrors(this.hmrStart ?? this.tick())
      this.hmrStart = null
      return
    }
    if (level !== 'warning' && level !== 'error') return
    const text = message.slice(0, MAX_TEXT)
    const last = this.messages.at(-1)
    // React and HMR clients often repeat the same message; keep one.
    if (last && last.level === level && last.message === text) return
    this.messages.push({ level, message: text, source, at: this.tick() })
    if (this.messages.length > MAX_MESSAGES) this.messages.shift()
    if (level === 'error') this.changed()
  }

  addServerLine(line: string) {
    // Recovery lines (e.g. `hmr update /src/error-boundary.tsx`) can also match SERVER_ERROR.
    if (SERVER_RECOVERED.test(line)) {
      if (this.serverErrors.length) {
        this.serverErrors = []
        this.changed()
      }
      return
    }
    if (!SERVER_ERROR.test(line) || NOT_AN_ERROR.test(line) || STACK_FRAME.test(line)) return
    const message = line.slice(0, MAX_TEXT)
    if (this.serverErrors.some((p) => p.message === message)) return
    this.serverErrors.push({ id: randomUUID(), source: 'server', message, at: Date.now() })
    if (this.serverErrors.length > MAX_SERVER_ERRORS) this.serverErrors.shift()
    this.changed()
  }

  /** A new document starts with a clean console. */
  clearConsole() {
    this.hmrStart = null
    if (this.messages.length === 0) return
    this.messages = []
    this.flush()
  }

  clear() {
    this.messages = []
    this.serverErrors = []
    this.hmrStart = null
    this.flush()
  }

  dispose() {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    this.removeAllListeners()
  }

  /** Drops console errors logged before `before`; warnings stay as history. */
  private clearConsoleErrors(before: number) {
    const kept = this.messages.filter((m) => m.level !== 'error' || m.at >= before)
    if (kept.length === this.messages.length) return
    this.messages = kept
    this.changed()
  }

  private tick() {
    this.clock = Math.max(Date.now(), this.clock + 1)
    return this.clock
  }

  private changed() {
    this.emitTimer ??= setTimeout(() => this.flush(), CHANGE_THROTTLE_MS)
  }

  /** Emits now if the current problems differ from the last ones emitted. */
  private flush() {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    const problems = this.list()
    const ids = problems.map((p) => p.id).join('\n')
    if (ids === this.emittedIds) return
    this.emittedIds = ids
    this.emit('change', problems)
  }
}
