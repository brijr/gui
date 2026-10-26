import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { type IPty, spawn as spawnPty } from 'node-pty'
import type { TerminalOutput } from '../shared/ipc'
import type { TerminalId, TerminalInfo } from '../shared/types'
import { Output } from './output'
import { endProcessGroups } from './process-groups'
import { getShellEnv } from './shell-env'

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
  /** What it printed, kept to draw again and sent while it's on screen */
  readonly output: Output
  size: { cols: number; rows: number }
}

export interface TerminalsEvents {
  /** Output from a terminal's shell, for the drawer while it shows the terminal */
  data: [output: TerminalOutput]
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
  /** Settles once every shell, and everything they started, has exited */
  private ended: Promise<void> | null = null

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

  output(id: TerminalId): TerminalOutput {
    return { ...(this.shells.get(id)?.output.snapshot() ?? { data: '', end: 0 }), id }
  }

  /**
   * The terminal on screen, if any: only its output is sent to the drawer, and only its shell
   * ever waits for the drawer to draw. The others go on, keeping what they print.
   */
  show(id: TerminalId | null) {
    for (const shell of this.shells.values()) shell.output.setShown(shell.id === id)
  }

  /** The drawer has drawn the terminal's output up to `end`. */
  ack(id: TerminalId, end: number) {
    this.shells.get(id)?.output.ack(end)
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
      output: new Output(id, {
        send: (chunk) => this.emit('data', { ...chunk, id }),
        // node-pty stops reading, so the shell's writes wait. Typing still reaches it, so ⌃C
        // stops a flood at once. (A shell exiting meanwhile waits for its output to be read.)
        hold: (held) => (held ? shell.proc?.pause() : shell.proc?.resume()),
      }),
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
    this.shells.get(id)?.output.clear()
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
    shell.output.dispose()
    void end([shell])
    this.emit('change')
  }

  /**
   * Ends every shell; the project or its tab closed, or Gui is quitting. They're gone from
   * here at once, and the returned promise settles once their processes have exited.
   */
  dispose(): Promise<void> {
    if (this.ended) return this.ended
    for (const shell of this.shells.values()) shell.output.dispose()
    this.ended = end([...this.shells.values()])
    this.shells.clear()
    this.removeAllListeners()
    return this.ended
  }

  private async start(shell: Shell) {
    const run = ++shell.run
    const env = await getShellEnv()
    if (this.ended || run !== shell.run || this.shells.get(shell.id) !== shell) return

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
      shell.output.append(`${ESC}[31mCouldn't start your shell: ${message}${ESC}[0m\r\n`)
      shell.exited = true
      this.emit('change')
      return
    }
    shell.proc = proc
    proc.onData((chunk) => {
      if (run === shell.run) shell.output.append(chunk)
    })
    proc.onExit(() => {
      if (run !== shell.run) return
      shell.proc = null
      shell.exited = true
      shell.output.append(`\r\n${ESC}[2m[process exited]${ESC}[0m\r\n`)
      this.emit('change')
    })
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
 * own), then kills whatever is still there after a moment. Runs in the background; a quit
 * meanwhile finishes it before Gui exits.
 */
function end(shells: Shell[]): Promise<void> {
  const procs = shells.flatMap((shell) => (shell.proc ? [shell.proc] : []))
  for (const shell of shells) {
    shell.run++
    shell.proc = null
  }
  return endProcessGroups(procs, 'SIGHUP', HANGUP_GRACE_MS)
}
