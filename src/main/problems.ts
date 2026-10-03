import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Problem } from '../shared/types'

const MAX_MESSAGES = 100
const MAX_SERVER_ERRORS = 20
const MAX_TEXT = 2000

/** Dev server output that means compilation or a request failed. */
const SERVER_ERROR =
  /\b(error|failed to (compile|resolve|load)|cannot find module|unexpected token|syntaxerror|typeerror|referenceerror)\b|⨯|✘/i
const NOT_AN_ERROR = /\b0 errors?\b|\bno errors?\b|error_reporting|errorBoundary/i
/** `at fn (file:line)` lines belong to the error above them, not a new error. */
const STACK_FRAME = /^\s*at\s+\S/
/** Output that means the dev server recovered (a successful rebuild or hot update). */
const SERVER_RECOVERED = /\bhmr update\b|\bpage reload\b|\bcompiled\b|\bready in\b|✓/i

export interface ConsoleEntry {
  level: 'warning' | 'error'
  message: string
  source: string
  at: number
}

/**
 * What's currently wrong with the previewed app: console errors since the last
 * navigation and dev-server errors since its last successful rebuild.
 */
export class Problems extends EventEmitter<{ change: [problems: Problem[]] }> {
  private messages: ConsoleEntry[] = []
  private serverErrors: Problem[] = []

  /** Current errors, newest last. */
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
    return [...consoleErrors, ...this.serverErrors].sort((a, b) => a.at - b.at).slice(-10)
  }

  /** Recent console warnings and errors, for the agent's console tool. */
  recentConsole() {
    return this.messages.slice()
  }

  addConsole(level: 'info' | 'warning' | 'error' | 'debug', message: string, source: string) {
    if (level !== 'warning' && level !== 'error') return
    const text = message.slice(0, MAX_TEXT)
    const last = this.messages.at(-1)
    // React and HMR clients often repeat the same message; keep one.
    if (last && last.level === level && last.message === text) return
    this.messages.push({ level, message: text, source, at: Date.now() })
    if (this.messages.length > MAX_MESSAGES) this.messages.shift()
    if (level === 'error') this.changed()
  }

  addServerLine(line: string) {
    if (SERVER_RECOVERED.test(line) && this.serverErrors.length) {
      this.serverErrors = []
      this.changed()
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
    if (this.messages.length === 0) return
    const hadErrors = this.messages.some((m) => m.level === 'error')
    this.messages = []
    if (hadErrors) this.changed()
  }

  clear() {
    this.messages = []
    this.serverErrors = []
    this.changed()
  }

  private changed() {
    this.emit('change', this.list())
  }
}
