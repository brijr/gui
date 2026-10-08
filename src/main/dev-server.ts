import { EventEmitter } from 'node:events'
import { type IPty, spawn as spawnPty } from 'node-pty'
import type { OutputChunk } from '../shared/ipc'
import type { DevServerState } from '../shared/types'
import { Output } from './output'
import { listenersOn, loopbackFor, portOpen, processGroups } from './ports'
import { groupAlive, processGroupsOf, signalGroups } from './process-groups'
import { getShellEnv } from './shell-env'

const PROBE_TIMEOUT_MS = 120_000
/** Most dev servers are up well within this; past it, the UI offers a way forward. */
const SLOW_START_MS = 30_000
/** After this long, accept any listener on the port even if we can't prove it's ours. */
const OWNERSHIP_GRACE_MS = 20_000
/** How long a stopped server and what it started get to exit before what's left is killed. */
const STOP_GRACE_MS = 3000
const ESC = '\u001b'
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\u0007]*(?:\u0007|${ESC}\\\\)`, 'g')
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)(?::\d{2,5})?[^\s'"]*/

const stripAnsi = (text: string) => text.replace(ANSI, '')
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  /** Its output and Gui's notes in between, kept to draw again; never held up by the drawer */
  readonly output = new Output(`logs-${++lastLogsId}`, {
    send: (chunk) => this.emit('data', chunk),
  })
  /** Incomplete last line of output; URLs and escape codes can span PTY reads. */
  private partial = ''
  private lastLineTimer: NodeJS.Timeout | null = null
  private pendingLastLine: string | null = null
  private size = { cols: 120, rows: 30 }
  private run = 0
  private stopping = false
  /** A one-off command is running; its output isn't the dev server's. */
  private task = false

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

  async start(command: string) {
    // A restart or app switch can still be waiting on the old server when its tab closes.
    if (this.proc || this.disposed) return
    const run = ++this.run
    const env = await getShellEnv()
    if (run !== this.run) return

    // The last line so far belongs to an earlier run or the install.
    this.pendingLastLine = null
    this.stopping = false
    this.partial = ''
    this.write(`\r\n${ESC}[2m$ ${command}${ESC}[0m\r\n`)
    this.update({
      status: 'starting',
      command,
      url: null,
      exitCode: null,
      lastLine: '',
      slow: false,
    })
    setTimeout(() => {
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
   * streaming into the same log. Resolves with its exit code; null if it couldn't start,
   * was stopped, or was superseded.
   */
  async runTask(command: string, cwd: string): Promise<number | null> {
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
    return new Promise((resolve) => {
      proc.onExit(({ exitCode, signal }) => {
        if (run !== this.run) return resolve(null)
        this.proc = null
        this.write(`\r\n${ESC}[2m[process exited with code ${exitCode}]${ESC}[0m\r\n`)
        resolve(signal || this.stopping ? null : exitCode)
      })
    })
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
    const groups = processGroupsOf([proc])
    signalGroups(groups, 'SIGTERM')
    return (async () => {
      const deadline = Date.now() + STOP_GRACE_MS
      let alive = groups.filter(groupAlive)
      while (alive.length > 0 && Date.now() < deadline) {
        await sleep(50)
        alive = alive.filter(groupAlive)
      }
      signalGroups(alive, 'SIGKILL')
    })()
  }

  /** Stops whatever is running and resolves once it and everything it started have exited. */
  async stopAndWait() {
    if (!this.proc) return
    const exited = this.exited
    await Promise.all([this.stop(), exited])
  }

  async restart() {
    const command = this.state.command
    if (!command) return
    await this.stopAndWait()
    await this.start(command)
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

  dispose() {
    this.disposed = true
    this.run++
    this.output.dispose()
    if (this.lastLineTimer) clearTimeout(this.lastLineTimer)
    if (this.proc) signalGroups(processGroupsOf([this.proc]), 'SIGKILL')
    this.proc = null
    this.removeAllListeners()
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
      env: { ...env, FORCE_COLOR: '1', BROWSER: 'none', TERM: 'xterm-256color' },
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

    if (this.state.status !== 'starting' || this.state.url) return
    for (const line of lines) {
      const match = line.match(LOCAL_URL)
      const url = match ? normalizeUrl(match[0]) : null
      if (!url) continue
      this.update({ url })
      void this.waitUntilReachable(url, this.run)
      return
    }
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

  private async waitUntilReachable(url: string, run: number) {
    const parsed = new URL(url)
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
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
    this.state = { ...this.state, ...patch, slow }
    this.emit('change', this.state)
  }
}

async function anyLoopbackOpen(port: number) {
  return (await portOpen('127.0.0.1', port)) || (await portOpen('::1', port))
}
