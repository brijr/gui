import { homedir } from 'node:os'
import { app, autoUpdater, net, powerMonitor } from 'electron'
import { officialBuild } from './official-build'
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

let ending = false

/** Gui is quitting, or the system is ending it (logging out, restarting, installing an update). */
export function appEnding() {
  return ending
}

/**
 * Once the app is ready. While Gui ends, its pages go away and late requests find no window:
 * that isn't a renderer or a window failing, so neither is reported from then on.
 */
export function watchAppEnding() {
  const end = () => {
    ending = true
  }
  app.on('before-quit', end)
  app.on('will-quit', end)
  powerMonitor.on('shutdown', end)
  autoUpdater.on('before-quit-for-update', end)
}

/** Paths name the user (/Users/name/…); the folder is replaced by ~. */
function scrub(text: string, max: number) {
  return scrubPaths(text, homedir()).slice(0, max)
}

/** Ends a user name in a Windows path: a separator, or a character no file name has. */
const WINDOWS_NAME = '[^\\\\/\\r\\n"\'<>|:*?]+'

/**
 * `text` with the user's home folder replaced by ~, and the name in any other user's folder
 * (/Users/name, C:\Users\name) too. A Windows home appears as `C:\Users\name`, escaped
 * (`C:\\Users\\name`), with slashes (`C:/Users/name`, as in file URLs) and in any case;
 * Windows user names may have spaces.
 */
export function scrubPaths(text: string, home: string) {
  let out = text.split(home).join('~')
  if (/^[A-Za-z]:\\/.test(home)) {
    const forward = home.replaceAll('\\', '/')
    const variants = [home, home.replaceAll('\\', '\\\\'), forward, encodeURI(forward)]
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(escaped, 'gi'), '~')
    }
  }
  return out
    .replace(new RegExp(`(\\\\+)(Users|Documents and Settings)\\1${WINDOWS_NAME}`, 'gi'), '$1$2$1~')
    .replace(
      new RegExp(`([A-Za-z]:/+)(Users|Documents and Settings)/${WINDOWS_NAME}`, 'gi'),
      '$1$2/~',
    )
    .replace(/\/Users\/[^/\s]+/g, '/Users/~')
}

export function errorReport(kind: CrashKind, error: unknown): CrashReport {
  if (error instanceof Error) return { kind, message: error.message, stack: error.stack }
  return { kind, message: String(error) }
}

export function sendCrashReport(report: CrashReport) {
  if (!officialBuild || !getPrefs().crashReports) return
  if (ending && (report.kind === 'renderer' || report.kind === 'window')) return
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
