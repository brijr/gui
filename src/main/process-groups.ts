import { basename } from 'node:path'
import type { IPty } from 'node-pty'
import { execFile, execFileSync } from './process'

interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  /** Its controlling terminal ("ttys012"), or "??" */
  tty: string
}

/**
 * The process groups of the PTYs' processes and of everything on their terminals or
 * descended from them. Read while the processes (and so their terminals) are still there:
 * a terminal device freed by an exited process can already belong to someone else's.
 * Blocks while `ps` runs; `endProcessGroups` reads it without blocking.
 */
export function processGroupsOf(procs: IPty[]): number[] {
  return groupsIn(processTable(), procs)
}

function groupsIn(rows: ProcessRow[], procs: IPty[]): number[] {
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

const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,tty=']
const PS_OPTIONS = { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 } as const

function processTable(): ProcessRow[] {
  try {
    return parseTable(execFileSync('/bin/ps', PS_ARGS, PS_OPTIONS))
  } catch {
    // Without the table, the shells' own groups are still ended.
    return []
  }
}

/** The same table without blocking: `ps` runs while Gui goes on. */
function readProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile('/bin/ps', PS_ARGS, PS_OPTIONS, (error, out) => resolve(error ? [] : parseTable(out)))
  })
}

function parseTable(out: string): ProcessRow[] {
  return out.split('\n').flatMap((line) => {
    const [pid, ppid, pgid, tty = ''] = line.trim().split(/\s+/)
    const row = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), tty }
    return Number.isInteger(row.pid) && Number.isInteger(row.pgid) && row.pid > 0 ? [row] : []
  })
}

/** Ends under way, so quitting can finish them: their timers die with Gui. */
const ending = new Set<Ending>()

interface Ending {
  readonly procs: IPty[]
  readonly signal: NodeJS.Signals
  readonly graceMs: number
  /** Null until the process table has been read and `signal` sent */
  groups: number[] | null
  /** When what's left of `groups` is killed */
  deadline: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Ends the PTYs' processes and everything they started, without blocking Gui: reads the
 * process table, sends `signal` to every group, and kills whatever is left after `graceMs`.
 * Resolves once they're all gone. Quitting meanwhile finishes the job (`finishEndingSync`).
 */
export async function endProcessGroups(
  procs: IPty[],
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<void> {
  if (procs.length === 0) return
  const job: Ending = { procs, signal, graceMs, groups: null, deadline: 0 }
  ending.add(job)
  try {
    const rows = await readProcessTable()
    // Quitting finished it while `ps` ran.
    if (!ending.has(job)) return
    const groups = groupsIn(rows, procs)
    job.groups = groups
    job.deadline = Date.now() + graceMs
    signalGroups(groups, signal)
    let alive = groups.filter(groupAlive)
    while (alive.length > 0 && Date.now() < job.deadline) {
      await sleep(20)
      alive = alive.filter(groupAlive)
    }
    signalGroups(alive, 'SIGKILL')
    // SIGKILL can't be refused, but takes a moment to land. Bounded, as nothing waits on a
    // process that the kernel won't let go (stuck in a disk read, say).
    for (let tries = 0; tries < 50 && alive.length > 0; tries++) {
      await sleep(20)
      alive = alive.filter(groupAlive)
    }
  } finally {
    ending.delete(job)
  }
}

/**
 * Gui is quitting: finishes every end still under way, here and now, the way it would have
 * gone (the signal, the rest of the grace period, then SIGKILL), since nothing runs after.
 */
export function finishEndingSync() {
  const jobs = [...ending]
  ending.clear()
  const groups: number[] = []
  for (const job of jobs) {
    if (job.groups === null) {
      job.groups = processGroupsOf(job.procs)
      job.deadline = Date.now() + job.graceMs
      signalGroups(job.groups, job.signal)
    }
    groups.push(...job.groups)
  }
  const deadline = Math.max(0, ...jobs.map((job) => job.deadline))
  let alive = groups.filter(groupAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(20)
    alive = alive.filter(groupAlive)
  }
  signalGroups(alive, 'SIGKILL')
}

export function signalGroups(groups: number[], signal: NodeJS.Signals) {
  for (const group of groups) {
    try {
      process.kill(-group, signal)
    } catch {
      // already gone
    }
  }
}

export function groupAlive(group: number) {
  try {
    process.kill(-group, 0)
    return true
  } catch {
    return false
  }
}

export function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
