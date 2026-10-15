import { homedir } from 'node:os'
import { app, net } from 'electron'
import { getPrefs } from './prefs'

/**
 * Crash reports: when Gui itself fails (an uncaught error in main, a window that can't draw,
 * a renderer or helper process that crashes), installed copies send what failed and where to
 * usegui.com/crash. Only Gui's own errors: never the user's code, files, chats, or the pages
 * they preview. Settings → Account turns them off. The privacy page says what is sent.
 */

const ENDPOINT = 'https://usegui.com/crash'
/** A loop that throws doesn't send a report per turn. */
const MAX_PER_SESSION = 20
const MAX_MESSAGE = 500
const MAX_STACK = 4000

export type CrashKind = 'main' | 'rejection' | 'renderer' | 'window' | 'process'

export interface CrashReport {
  kind: CrashKind
  message: string
  stack?: string
}

const sent = new Set<string>()

/** Paths name the user (/Users/name/…); the folder is replaced by ~. */
function scrub(text: string, max: number) {
  const home = homedir()
  return text
    .split(home)
    .join('~')
    .replace(/\/Users\/[^/\s]+/g, '/Users/~')
    .slice(0, max)
}

export function errorReport(kind: CrashKind, error: unknown): CrashReport {
  if (error instanceof Error) return { kind, message: error.message, stack: error.stack }
  return { kind, message: String(error) }
}

export function sendCrashReport(report: CrashReport) {
  if (!app.isPackaged || !getPrefs().crashReports) return
  const message = scrub(report.message || 'No message', MAX_MESSAGE)
  const stack = report.stack ? scrub(report.stack, MAX_STACK) : null
  // The same failure once per session: the first line of its stack says where.
  const key = `${report.kind}\n${message}\n${stack?.split('\n')[1] ?? ''}`
  if (sent.has(key) || sent.size >= MAX_PER_SESSION) return
  sent.add(key)
  const body = JSON.stringify({
    kind: report.kind,
    message,
    stack,
    version: app.getVersion(),
    os: process.getSystemVersion(),
    arch: process.arch,
  })
  net
    .fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    .catch(() => undefined)
}
