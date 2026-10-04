import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { basename } from 'node:path'
import { app } from 'electron'
import { type IPty, spawn as spawnPty } from 'node-pty'
import type { TerminalId, TerminalInfo } from '../shared/types'
import { getShellEnv } from './shell-env'

/** Output kept per terminal, to draw it again after switching tabs; as much as the dev server's. */
const MAX_OUTPUT = 512 * 1024
/** How long hung-up shells and their jobs get to exit before what's left is killed. */
const HANGUP_GRACE_MS = 500
const ESC = '\u001b'

let lastTerminalId = 0

interface Shell {
  readonly id: TerminalId
  /** Names it: "Terminal", "Terminal 2"… */
  readonly number: number
  proc: IPty | null
  /** Bumped per shell started, and when it's ended here, so a replaced shell's exit is dropped */
  run: number
  exited: boolean
  output: string
  size: { cols: number; rows: number }
}

export interface TerminalsEvents {
  /** Output from a terminal's shell */
  data: [id: TerminalId, chunk: string]
  /** A terminal was added or removed, or its shell exited or started again */
  change: []
}

/**
 * A project's terminals in the drawer (not Terminal.app, which terminal.ts opens): the user's
 * own login shell in a PTY at the project root, started only when the user opens one. Each
 * keeps its recent output so the drawer can draw it again after switching tabs, and ending
 * one ends everything it started.
 */
export class Terminals extends EventEmitter<TerminalsEvents> {
  /** In tab order */
  private readonly shells = new Map<TerminalId, Shell>()
  private disposed = false

  constructor(private readonly cwd: string) {
    super()
  }

  list(): TerminalInfo[] {
    return [...this.shells.values()].map((shell) => ({
      id: shell.id,
      title: shell.number === 1 ? 'Terminal' : `Terminal ${shell.number}`,
      exited: shell.exited,
    }))
  }

  has(id: TerminalId) {
    return this.shells.has(id)
  }

  output(id: TerminalId) {
    return this.shells.get(id)?.output ?? ''
  }

  /** Adds a terminal and starts its shell; the terminal is there at once, the shell a moment later. */
  create(): TerminalId {
    const id: TerminalId = `terminal-${++lastTerminalId}`
    // Named by the lowest number free, so closing "Terminal 2" frees its name.
    const taken = new Set([...this.shells.values()].map((shell) => shell.number))
    let number = 1
    while (taken.has(number)) number++
    const shell: Shell = {
      id,
      number,
      proc: null,
      run: 0,
      exited: false,
      output: '',
      size: { cols: 80, rows: 24 },
    }
    this.shells.set(id, shell)
    void this.start(shell)
    this.emit('change')
    return id
  }

  write(id: TerminalId, data: string) {
    this.shells.get(id)?.proc?.write(data)
  }

  resize(id: TerminalId, cols: number, rows: number) {
    const shell = this.shells.get(id)
    if (!shell || cols < 2 || rows < 2) return
    shell.size = { cols, rows }
    try {
      shell.proc?.resize(cols, rows)
    } catch {
      // The shell exited and onExit hasn't fired yet.
    }
  }

  /** ⌘K: forgets what the terminal showed, except the line the cursor is on (the prompt). */
  clear(id: TerminalId) {
    const shell = this.shells.get(id)
    if (shell) shell.output = shell.output.slice(shell.output.lastIndexOf('\n') + 1)
  }

  /** A new shell in place of one that exited, below what the old one showed. */
  restart(id: TerminalId) {
    const shell = this.shells.get(id)
    if (!shell?.exited) return
    shell.exited = false
    void this.start(shell)
    this.emit('change')
  }

  close(id: TerminalId) {
    const shell = this.shells.get(id)
    if (!shell) return
    this.shells.delete(id)
    end([shell])
    this.emit('change')
  }

  /** Ends every shell; the project or its tab closed, or Gui is quitting. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    end([...this.shells.values()])
    this.shells.clear()
    this.removeAllListeners()
  }

  private async start(shell: Shell) {
    const run = ++shell.run
    const env = await getShellEnv()
    if (this.disposed || run !== shell.run || this.shells.get(shell.id) !== shell) return

    let proc: IPty
    try {
      // A login shell, as Terminal starts it; on a terminal, it's interactive.
      proc = spawnPty(env.SHELL || '/bin/zsh', ['-l'], {
        name: 'xterm-256color',
        cols: shell.size.cols,
        rows: shell.size.rows,
        cwd: this.cwd,
        env: terminalEnv(env),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.append(shell, `${ESC}[31mCouldn't start your shell: ${message}${ESC}[0m\r\n`)
      shell.exited = true
      this.emit('change')
      return
    }
    shell.proc = proc
    proc.onData((chunk) => {
      if (run === shell.run) this.append(shell, chunk)
    })
    proc.onExit(() => {
      if (run !== shell.run) return
      shell.proc = null
      shell.exited = true
      this.append(shell, `\r\n${ESC}[2m[process exited]${ESC}[0m\r\n`)
      this.emit('change')
    })
  }

  private append(shell: Shell, chunk: string) {
    shell.output += chunk
    if (shell.output.length > MAX_OUTPUT) {
      // From the start of a line, so drawing it again doesn't begin inside an escape sequence.
      const kept = shell.output.slice(-MAX_OUTPUT)
      shell.output = kept.slice(kept.indexOf('\n') + 1)
    }
    this.emit('data', shell.id, chunk)
  }
}

/** The login shell's environment, set up the way a terminal app does. */
function terminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shellEnv: NodeJS.ProcessEnv = {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Not the terminal Gui was started from (in development), whose shell integration
    // would misfire here.
    TERM_PROGRAM: 'Gui',
    TERM_PROGRAM_VERSION: app.getVersion(),
  }
  // Left over from resolving the environment through a shell; this one starts afresh.
  for (const key of ['TERM_SESSION_ID', 'SHLVL', 'OLDPWD']) delete shellEnv[key]
  // An app opened from Finder has no locale, and without one shells mangle anything but ASCII.
  if (!shellEnv.LANG && !shellEnv.LC_ALL && !shellEnv.LC_CTYPE) shellEnv.LANG = 'en_US.UTF-8'
  return shellEnv
}

/**
 * Ends shells and everything they started, as closing a terminal window does: hangs up on
 * their process groups (the shell's, and each job's, which job control gives a group of its
 * own), then kills whatever is still there after a moment. Waits for that here rather than
 * on a timer, so it's done before Gui quits.
 */
function end(shells: Shell[]) {
  const procs = shells.flatMap((shell) => (shell.proc ? [shell.proc] : []))
  for (const shell of shells) {
    shell.run++
    shell.proc = null
  }
  if (procs.length === 0) return
  const groups = processGroupsOf(procs)
  signalGroups(groups, 'SIGHUP')
  const deadline = Date.now() + HANGUP_GRACE_MS
  let alive = groups.filter(groupAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(20)
    alive = alive.filter(groupAlive)
  }
  signalGroups(alive, 'SIGKILL')
}

interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  /** Its controlling terminal ("ttys012"), or "??" */
  tty: string
}

/**
 * The process groups of the shells and of everything on their terminals or descended from
 * them. Read while the shells (and so their terminals) are still there: a terminal device
 * freed by an exited shell can already belong to someone else's.
 */
function processGroupsOf(procs: IPty[]): number[] {
  const rows = processTable()
  const children = new Map<number, number[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid])
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const ttys = new Set(procs.map(ttyOf).filter((tty) => tty !== null))

  const groups = new Set(procs.map((proc) => proc.pid))
  const seen = new Set<number>()
  const stack = procs.map((proc) => proc.pid)
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = byPid.get(pid)
    if (row) groups.add(row.pgid)
    stack.push(...(children.get(pid) ?? []))
  }
  for (const row of rows) if (ttys.has(row.tty)) groups.add(row.pgid)

  // Never Gui's own group, nor launchd's or the kernel's.
  const own = byPid.get(process.pid)?.pgid
  return [...groups].filter((group) => group > 1 && group !== own && group !== process.pid)
}

/** The PTY's device, as `ps` names it. */
function ttyOf(proc: IPty): string | null {
  const { ptsName } = proc as IPty & { ptsName?: string }
  return ptsName ? basename(ptsName) : null
}

function processTable(): ProcessRow[] {
  try {
    const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,tty='], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return out.split('\n').flatMap((line) => {
      const [pid, ppid, pgid, tty = ''] = line.trim().split(/\s+/)
      const row = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), tty }
      return Number.isInteger(row.pid) && Number.isInteger(row.pgid) && row.pid > 0 ? [row] : []
    })
  } catch {
    // Without the table, the shells' own groups are still ended.
    return []
  }
}

function signalGroups(groups: number[], signal: NodeJS.Signals) {
  for (const group of groups) {
    try {
      process.kill(-group, signal)
    } catch {
      // already gone
    }
  }
}

function groupAlive(group: number) {
  try {
    process.kill(-group, 0)
    return true
  } catch {
    return false
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
