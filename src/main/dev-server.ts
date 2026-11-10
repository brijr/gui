import { EventEmitter } from 'node:events'
import { type IPty, spawn as spawnPty } from 'node-pty'
import type { OutputChunk } from '../shared/ipc'
import type { DevServerState } from '../shared/types'
import {
  type AddressCandidate,
  findInterval,
  type PageKind,
  pickAddress,
  portOf,
  probePage,
  RECENT_OUTPUT_MS,
  SLOW_START_MS,
} from './app-address'
import { Output } from './output'
import { listenersOf, listenersOn, loopbackFor, portOpen, processGroups } from './ports'
import { endProcessGroups } from './process-groups'
import { getShellEnv } from './shell-env'

const PROBE_TIMEOUT_MS = 120_000
/** A port that isn't a web page yet is asked again after this long. */
const REPROBE_MS = 1500
/** Addresses a server prints that are kept as candidates; the first ones count. */
const MAX_PRINTED = 10
/** After this long, accept any listener on the port even if we can't prove it's ours. */
const OWNERSHIP_GRACE_MS = 20_000
/** How long a stopped server and what it started get to exit before what's left is killed. */
const STOP_GRACE_MS = 3000
const ESC = '\u001b'
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\u0007]*(?:\u0007|${ESC}\\\\)`, 'g')
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)(?::\d{2,5})?[^\s'"]*/g

const stripAnsi = (text: string) => text.replace(ANSI, '')

let lastLogsId = 0

function normalizeUrl(raw: string) {
  try {
    const url = new URL(raw.replace(/[).,;]+$/, ''))
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '[::1]') {
      url.hostname = 'localhost'
    }
    return url.toString()
  } catch {
    return null
  }
}

export interface DevServerEvents {
  /** Output for the drawer's logs, while they're on screen */
  data: [chunk: OutputChunk]
  change: [state: DevServerState]
  /** One complete line of output, escape codes stripped */
  line: [line: string]
}

/**
 * Runs the project's dev script in a real PTY and detects when its URL is reachable.
 * One-off setup commands (installing dependencies) run in the same terminal before it.
 */
export class DevServer extends EventEmitter<DevServerEvents> {
  state: DevServerState = {
    status: 'idle',
    command: null,
    url: null,
    exitCode: null,
    lastLine: '',
    slow: false,
  }
  private proc: IPty | null = null
  /** Settles when `proc` has exited and its exit has been handled. */
  private exited: Promise<void> = Promise.resolve()
  private disposed = false
  /** Settles once a disposed server's processes have exited */
  private ended: Promise<void> | null = null
  /** Its output and Gui's notes in between, kept to draw again; never held up by the drawer */
  readonly output = new Output(`logs-${++lastLogsId}`, {
    send: (chunk) => this.emit('data', chunk),
  })
  /** Incomplete last line of output; URLs and escape codes can span PTY reads. */
  private partial = ''
  private lastLineTimer: NodeJS.Timeout | null = null
  private slowTimer: NodeJS.Timeout | null = null
  private pendingLastLine: string | null = null
  private size = { cols: 120, rows: 30 }
  private run = 0
  private stopping = false
  /** A one-off command is running; its output isn't the dev server's. */
  private task = false
  /** The app's address when it's set rather than read from the output */
  private fixedUrl: string | null = null
  /** Local addresses this run printed, in order: candidates for the app's address */
  private printed: string[] = []
  /** Cuts `findApp`'s wait short: there's something new to look at, or nothing left to find. */
  private wakeFind = () => {}
  /** When the starting server last printed anything (or was started) */
  private lastOutput = 0

  /** `cwd` is where the dev script runs: the project root, or a monorepo app's folder. */
  constructor(private cwd: string) {
    super()
  }

  logs() {
    return this.output.snapshot().data
  }

  /** Takes effect on the next start. */
  setCwd(cwd: string) {
    this.cwd = cwd
  }

  /** `url` is where the app will answer, for a server that doesn't print its address. */
  async start(command: string, url: string | null = null) {
    // A restart or app switch can still be waiting on the old server when its tab closes.
    if (this.proc || this.disposed) return
    this.fixedUrl = url
    const run = ++this.run
    const env = await getShellEnv()
    if (run !== this.run) return

    // The last line so far belongs to an earlier run or the install.
    this.pendingLastLine = null
    this.stopping = false
    this.partial = ''
    this.printed = []
    this.lastOutput = Date.now()
    this.write(`\r\n${ESC}[2m$ ${command}${ESC}[0m\r\n`)
    this.update({
      status: 'starting',
      command,
      url: null,
      exitCode: null,
      lastLine: '',
      slow: false,
    })
    if (this.slowTimer) clearTimeout(this.slowTimer)
    this.slowTimer = setTimeout(() => {
      if (run === this.run && this.state.status === 'starting') this.update({ slow: true })
    }, SLOW_START_MS).unref()

    let proc: IPty
    try {
      proc = this.spawn(command, this.cwd, env, run, false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.write(`${ESC}[31mCouldn't start the dev server: ${message}${ESC}[0m\r\n`)
      this.update({ status: 'exited', exitCode: null, lastLine: `Couldn't start: ${message}` })
      return
    }
    if (url) {
      this.update({ url })
      void this.waitUntilReachable(url, run)
    } else void this.findApp(run)
    proc.onExit(({ exitCode: code, signal }) => {
      if (run !== this.run) return
      this.proc = null
      // Killed by a signal (a crash, the OOM killer) is a failure too: 128 + the signal, as a
      // shell reports it. node-pty says exit code 0 then.
      const exitCode = signal ? 128 + signal : code
      this.write(`\r\n${ESC}[2m[process exited with code ${exitCode}]${ESC}[0m\r\n`)
      this.update(
        this.stopping
          ? { status: 'idle', url: null, exitCode: null }
          : { status: 'exited', url: null, exitCode },
      )
    })
  }

  /**
   * Runs a one-off command (e.g. `bun install`) in `cwd` while the dev server is stopped,
   * streaming into the same log. Resolves with its exit code; 'timeout' when it ran past
   * `timeoutMs` and was stopped; null if it couldn't start, was stopped, or was superseded.
   */
  async runTask(
    command: string,
    cwd: string,
    timeoutMs: number | null = null,
  ): Promise<number | 'timeout' | null> {
    if (this.proc || this.disposed) return null
    const run = ++this.run
    const env = await getShellEnv()
    if (run !== this.run) return null

    let proc: IPty
    try {
      proc = this.spawn(command, cwd, env, run, true)
    } catch (error) {
      this.print(`Couldn't run ${command}: ${error instanceof Error ? error.message : error}`)
      return null
    }
    let timedOut = false
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            timedOut = true
            void this.stop()
          }, timeoutMs)
    return new Promise((resolve) => {
      proc.onExit(({ exitCode, signal }) => {
        if (timer) clearTimeout(timer)
        if (run !== this.run) return resolve(null)
        this.proc = null
        this.write(`\r\n${ESC}[2m[process exited with code ${exitCode}]${ESC}[0m\r\n`)
        if (timedOut) return resolve('timeout')
        resolve(signal || this.stopping ? null : exitCode)
      })
    })
  }

  /** The server can't start (`message` says why): stopped, with the reason as its last line. */
  fail(message: string) {
    if (this.proc || this.disposed) return
    this.run++
    this.write(`${ESC}[31m${message}${ESC}[0m\r\n`)
    this.pendingLastLine = null
    this.update({ status: 'exited', url: null, exitCode: null, lastLine: message })
  }

  /** Restarting: an exit (a crash) is over, though nothing is running yet. */
  clearExit() {
    if (this.proc || this.disposed || this.state.status !== 'exited') return
    this.update({ status: 'idle', url: null, exitCode: null })
  }

  /** A message from Gui itself, shown in the log and as the status line. */
  print(message: string) {
    this.write(`${ESC}[33m${message}${ESC}[0m\r\n`)
    // Output coalesced before it must not replace it.
    this.pendingLastLine = null
    this.update({ lastLine: message })
  }

  /**
   * Asks the server and everything it started to stop, and kills what's left after a grace
   * period. Resolves once they're all gone. The package manager the PTY runs often exits on
   * SIGTERM first while the server it started lingers, so this follows every group, not it.
   */
  stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return Promise.resolve()
    this.stopping = true
    return endProcessGroups([proc], 'SIGTERM', STOP_GRACE_MS)
  }

  /** Stops whatever is running and resolves once it and everything it started have exited. */
  async stopAndWait() {
    if (!this.proc) return
    const exited = this.exited
    await Promise.all([this.stop(), exited])
  }

  resize(cols: number, rows: number) {
    if (cols < 2 || rows < 2) return
    this.size = { cols, rows }
    try {
      this.proc?.resize(cols, rows)
    } catch {
      // The process exited and onExit hasn't fired yet.
    }
  }

  /**
   * Kills the server and everything it started. Settles once they've exited, so the project
   * isn't opened again while they still run.
   */
  dispose(): Promise<void> {
    if (this.ended) return this.ended
    this.disposed = true
    this.run++
    this.wakeFind()
    this.output.dispose()
    if (this.lastLineTimer) clearTimeout(this.lastLineTimer)
    if (this.slowTimer) clearTimeout(this.slowTimer)
    this.ended = endProcessGroups(this.proc ? [this.proc] : [], 'SIGKILL', 0)
    this.proc = null
    this.removeAllListeners()
    return this.ended
  }

  /** Runs `command` in the user's login shell on a fresh PTY; throws if it can't start. */
  private spawn(command: string, cwd: string, env: NodeJS.ProcessEnv, run: number, task: boolean) {
    this.stopping = false
    this.task = task
    this.partial = ''
    this.write(`\r\n${ESC}[2m$ ${command}${ESC}[0m\r\n`)
    const proc = spawnPty(env.SHELL || '/bin/zsh', ['-lc', command], {
      name: 'xterm-256color',
      cols: this.size.cols,
      rows: this.size.rows,
      cwd,
      // Turborepo streams its tasks' output rather than drawing its full-screen UI, so the
      // logs read as lines (addresses, errors) like any other dev server's.
      env: { ...env, FORCE_COLOR: '1', BROWSER: 'none', TERM: 'xterm-256color', TURBO_UI: '0' },
    })
    this.proc = proc
    // Registered before the caller's exit handler, which has run by the time this settles.
    this.exited = new Promise((resolve) => proc.onExit(() => resolve()))
    proc.onData((chunk) => {
      if (run === this.run) this.onData(chunk)
    })
    return proc
  }

  private onData(chunk: string) {
    this.write(chunk)
    const parts = (this.partial + chunk).split(/\r\n|\n|\r/)
    this.partial = (parts.pop() ?? '').slice(-8000)
    const lines = parts.map((line) => stripAnsi(line).trim()).filter(Boolean)
    // Install output isn't a problem with the app.
    if (!this.task) for (const line of lines) this.emit('line', line)
    const last = lines.at(-1)
    if (last) this.setLastLine(last)

    if (this.state.status !== 'starting' || this.fixedUrl) return
    // Output almost always comes before or with the port: after a quiet spell, when the
    // looking has slowed down, look at once.
    const now = Date.now()
    if (now - this.lastOutput >= RECENT_OUTPUT_MS) this.wakeFind()
    this.lastOutput = now
    for (const line of lines) {
      for (const match of line.matchAll(LOCAL_URL)) {
        const url = normalizeUrl(match[0])
        if (!url || this.printed.includes(url) || this.printed.length >= MAX_PRINTED) continue
        this.printed.push(url)
        this.wakeFind()
        // The first address it printed, until the app is found: what "nothing answers at"
        // messages name.
        if (!this.state.url) this.update({ url })
      }
    }
  }

  /**
   * Finds the app while the server starts: the addresses it printed, and every port it (or
   * anything it started) listens on, so a server that only says "listening on port 3000",
   * or prints nothing, is found too. With several, the one serving a web page wins over an
   * API's (see `pickAddress`).
   */
  private async findApp(run: number) {
    const started = Date.now()
    const live = () => run === this.run && this.state.status === 'starting'
    const candidates = new Map<number, AddressCandidate>()
    /** When each port was last asked what it serves, and whether that's still in flight */
    const probes = new Map<number, { at: number; busy: boolean }>()
    let noted = false
    while (live()) {
      const pid = this.proc?.pid
      const listeners = pid ? await listenersOf(pid) : null
      if (!live()) return
      const now = Date.now()
      const elapsed = now - started
      const seen = new Map<number, { url: string; printed: number | null; host: string }>()
      for (const [index, url] of this.printed.entries()) {
        const port = portOf(url)
        if (seen.has(port)) continue
        const own = listeners?.find((l) => l.port === port)
        // Ours, or (after a while, or without lsof) anything answering there.
        const trusted = listeners === null || elapsed > OWNERSHIP_GRACE_MS
        if (own) seen.set(port, { url, printed: index, host: loopbackFor(own.host) })
        else if (trusted && (await anyLoopbackOpen(port))) {
          seen.set(port, { url, printed: index, host: '127.0.0.1' })
        }
      }
      for (const listener of listeners ?? []) {
        if (seen.has(listener.port)) continue
        const url = `http://localhost:${listener.port}/`
        seen.set(listener.port, { url, printed: null, host: loopbackFor(listener.host) })
      }
      if (!live()) return

      for (const port of candidates.keys()) if (!seen.has(port)) candidates.delete(port)
      for (const [port, found] of seen) {
        const known = candidates.get(port)
        if (!known || known.url !== found.url) {
          candidates.set(port, { ...found, port, kind: null, since: known?.since ?? now })
        }
        const candidate = candidates.get(port)
        const probe = probes.get(port)
        if (!candidate || candidate.kind === 'page' || probe?.busy) continue
        if (probe && now - probe.at < REPROBE_MS) continue
        probes.set(port, { at: now, busy: true })
        void probePage(found.url, found.host).then((kind: PageKind) => {
          probes.set(port, { at: Date.now(), busy: false })
          const current = candidates.get(port)
          if (current && current.url === found.url) current.kind = kind
          if (kind === 'page') this.wakeFind()
        })
      }

      const chosen = pickAddress([...candidates.values()], Date.now(), this.printed.length > 0)
      if (chosen) {
        const url = await this.pinnedUrl(chosen.url, chosen.port, pid)
        if (live()) this.update({ status: 'running', url })
        return
      }
      if (!noted && this.printed[0] && candidates.size === 0 && elapsed > PROBE_TIMEOUT_MS) {
        noted = true
        this.update({ lastLine: `No response from ${this.printed[0]} yet. Check the logs.` })
      }
      const wait = findInterval(elapsed, now - this.lastOutput, candidates.size > 0)
      // An address printed or a page found goes on at once, not a whole interval later; so
      // does the end of the run, which leaves no timer behind.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait)
        this.wakeFind = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  /**
   * Another project's server can hold the same port on the other address family
   * (e.g. [::1]:3000 vs 0.0.0.0:3000), and `localhost` may resolve to it: then the
   * address names our listener's loopback host instead.
   */
  private async pinnedUrl(url: string, port: number, pid: number | undefined) {
    const parsed = new URL(url)
    if (!pid || parsed.hostname !== 'localhost') return url
    const listeners = await listenersOn(port)
    if (!listeners) return url
    const groups = await processGroups([...new Set(listeners.map((l) => l.pid))])
    const ours = listeners.find((l) => groups.get(l.pid) === pid)
    if (!ours || !listeners.some((l) => groups.get(l.pid) !== pid)) return url
    parsed.hostname = loopbackFor(ours.host)
    return parsed.toString()
  }

  /** Chatty servers print constantly; coalesce status-line updates. */
  private setLastLine(line: string) {
    this.pendingLastLine = line.slice(0, 300)
    this.lastLineTimer ??= setTimeout(() => {
      this.lastLineTimer = null
      if (this.pendingLastLine !== null && this.pendingLastLine !== this.state.lastLine) {
        this.update({ lastLine: this.pendingLastLine })
      }
      this.pendingLastLine = null
    }, 100)
  }

  /** For an address set in Gui: running once something of ours answers there. */
  private async waitUntilReachable(url: string, run: number) {
    const parsed = new URL(url)
    const port = portOf(url)
    const started = Date.now()
    const live = () => run === this.run && this.state.status === 'starting'
    while (live() && Date.now() - started < PROBE_TIMEOUT_MS) {
      let ready = await this.ownListenerUrl(parsed, port)
      if (!ready && Date.now() - started > OWNERSHIP_GRACE_MS && (await anyLoopbackOpen(port))) {
        ready = url
      }
      if (ready) {
        if (live()) this.update({ status: 'running', url: ready })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    if (live()) {
      // Forget the URL so a later one in the output can still be picked up.
      this.update({ url: null, lastLine: `No response from ${url} yet. Check the logs.` })
    }
  }

  /**
   * Another project's server can hold the same port on the other address family
   * (e.g. [::1]:3000 vs 0.0.0.0:3000), and `localhost` may resolve to it. Only
   * trust listeners in our process group, and pin the loopback host on conflict.
   */
  private async ownListenerUrl(url: URL, port: number): Promise<string | null> {
    const pid = this.proc?.pid
    const listeners = await listenersOn(port)
    if (!pid || listeners === null) return (await anyLoopbackOpen(port)) ? url.toString() : null
    const groups = await processGroups([...new Set(listeners.map((l) => l.pid))])
    const ours = listeners.find((l) => groups.get(l.pid) === pid)
    if (!ours) return null
    const shadowed = listeners.some((l) => groups.get(l.pid) !== pid)
    if (url.hostname !== 'localhost' || !shadowed) return url.toString()
    const pinned = new URL(url)
    pinned.hostname = loopbackFor(ours.host)
    return pinned.toString()
  }

  private write(chunk: string) {
    this.output.append(chunk)
  }

  private update(patch: Partial<DevServerState>) {
    // Only a server that's still starting can be slow to start.
    const slow =
      (patch.status ?? this.state.status) === 'starting' && (patch.slow ?? this.state.slow)
    const wasStarting = this.state.status === 'starting'
    this.state = { ...this.state, ...patch, slow }
    // It exited or was found: `findApp` has nothing left to wait for.
    if (wasStarting && this.state.status !== 'starting') this.wakeFind()
    this.emit('change', this.state)
  }
}

async function anyLoopbackOpen(port: number) {
  return (await portOpen('127.0.0.1', port)) || (await portOpen('::1', port))
}
