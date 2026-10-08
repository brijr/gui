import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import type { IPty } from 'node-pty'

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
 */
export function processGroupsOf(procs: IPty[]): number[] {
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
