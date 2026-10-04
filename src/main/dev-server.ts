import { EventEmitter } from 'node:events'
import { type IPty, spawn as spawnPty } from 'node-pty'
import type { DevServerState } from '../shared/types'
import { listenersOn, loopbackFor, portOpen, processGroups } from './ports'
import { getShellEnv } from './shell-env'

const MAX_LOG = 512 * 1024
const PROBE_TIMEOUT_MS = 120_000
/** Most dev servers are up well within this; past it, the UI offers a way forward. */
const SLOW_START_MS = 30_000
/** After this long, accept any listener on the port even if we can't prove it's ours. */
const OWNERSHIP_GRACE_MS = 20_000
const ESC = '\u001b'
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\u0007]*(?:\u0007|${ESC}\\\\)`, 'g')
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)(?::\d{2,5})?[^\s'"]*/

const stripAnsi = (text: string) => text.replace(ANSI, '')

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
  data: [chunk: string]
  change: [state: DevServerState]
  /** The printed URL never became reachable; worth showing the logs. */
  stalled: []
  /** One complete line of output, escape codes stripped */
  line: [line: string]
}

/** Runs the project's dev script in a real PTY and detects when its URL is reachable. */
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
  private log = ''
  /** Incomplete last line of output; URLs and escape codes can span PTY reads. */
  private partial = ''
  private lastLineTimer: NodeJS.Timeout | null = null
  private pendingLastLine: string | null = null
  private size = { cols: 120, rows: 30 }
  private run = 0
  private stopping = false

  constructor(private readonly cwd: string) {
    super()
  }

  logs() {
    return this.log
  }

  async start(command: string) {
    if (this.proc) return
    const run = ++this.run
    const env = await getShellEnv()
    if (run !== this.run) return

    this.stopping = false
    this.partial = ''
    this.write(`\r\n${ESC}[2m$ ${command}${ESC}[0m\r\n`)
    this.update({ status: 'starting', command, url: null, exitCode: null, slow: false })
    setTimeout(() => {
      if (run === this.run && this.state.status === 'starting') this.update({ slow: true })
    }, SLOW_START_MS).unref()

    let proc: IPty
    try {
      proc = spawnPty(env.SHELL || '/bin/zsh', ['-lc', command], {
        name: 'xterm-256color',
        cols: this.size.cols,
        rows: this.size.rows,
        cwd: this.cwd,
        env: { ...env, FORCE_COLOR: '1', BROWSER: 'none', TERM: 'xterm-256color' },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.write(`${ESC}[31mCouldn't start the dev server: ${message}${ESC}[0m\r\n`)
      this.update({ status: 'exited', exitCode: null, lastLine: `Couldn't start: ${message}` })
      return
    }
    this.proc = proc
    proc.onData((chunk) => {
      if (run === this.run) this.onData(chunk)
    })
    proc.onExit(({ exitCode }) => {
      if (run !== this.run) return
      this.proc = null
      this.write(`\r\n${ESC}[2m[process exited with code ${exitCode}]${ESC}[0m\r\n`)
      this.update(
        this.stopping
          ? { status: 'idle', url: null, exitCode: null }
          : { status: 'exited', url: null, exitCode },
      )
    })
  }

  stop() {
    const proc = this.proc
    if (!proc) return
    this.stopping = true
    killGroup(proc.pid, 'SIGTERM')
    setTimeout(() => {
      if (this.proc === proc) killGroup(proc.pid, 'SIGKILL')
    }, 3000)
  }

  async restart() {
    const command = this.state.command
    if (!command) return
    if (this.proc) {
      const exited = new Promise<void>((resolve) => {
        const onChange = (state: DevServerState) => {
          if (state.status === 'running' || state.status === 'starting') return
          this.off('change', onChange)
          resolve()
        }
        this.on('change', onChange)
      })
      this.stop()
      await exited
    }
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
    this.run++
    if (this.lastLineTimer) clearTimeout(this.lastLineTimer)
    if (this.proc) killGroup(this.proc.pid, 'SIGKILL')
    this.proc = null
    this.removeAllListeners()
  }

  private onData(chunk: string) {
    this.write(chunk)
    const parts = (this.partial + chunk).split(/\r\n|\n|\r/)
    this.partial = (parts.pop() ?? '').slice(-8000)
    const lines = parts.map((line) => stripAnsi(line).trim()).filter(Boolean)
    for (const line of lines) this.emit('line', line)
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
      this.emit('stalled')
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
    this.log += chunk
    if (this.log.length > MAX_LOG) this.log = this.log.slice(-MAX_LOG)
    this.emit('data', chunk)
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

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    // The PTY child leads its own session, so its pid is also the process group id.
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}
