import { execFile } from './process'

/**
 * Windows' answers to `ps` and `lsof`, for ports.ts. Windows has no process groups, so
 * "everything a dev server started" is the processes descended from its shell, found by
 * parent pid (Windows never re-parents a process whose parent exits).
 *
 * Measured on GitHub's windows-latest runner: `netstat -ano` takes about 20 ms; the process
 * table, from PowerShell's CIM (wmic is gone from current Windows), about 300 ms warm and
 * 2.5 s the first time. So the table is read again only when a process starts listening
 * that the last table didn't know.
 */

export interface WindowsListener {
  pid: number
  /** As lsof names it: '*' for 0.0.0.0, '127.0.0.1', '[::]', '[::1]' */
  host: string
  port: number
}

const system32 = () => `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`

function run(file: string, args: string[], timeout: number) {
  return new Promise<string | null>((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : String(stdout)),
    )
  })
}

/** TCP sockets in the LISTENING state from `netstat -ano` output, IPv4 and IPv6. */
export function parseNetstat(text: string): WindowsListener[] {
  const listeners: WindowsListener[] = []
  for (const line of text.split(/\r?\n/)) {
    // Proto, local address, foreign address, state, pid. The state is localized on some
    // Windows; a listening socket is the one whose foreign port is 0.
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 5 || fields[0] !== 'TCP') continue
    const [, local = '', foreign = '', , pidText = ''] = fields
    if (!/:0$/.test(foreign)) continue
    const colon = local.lastIndexOf(':')
    const port = Number(local.slice(colon + 1))
    const pid = Number(pidText)
    if (colon <= 0 || !Number.isInteger(port) || port <= 0 || !Number.isInteger(pid)) continue
    const address = local.slice(0, colon)
    listeners.push({ pid, port, host: address === '0.0.0.0' ? '*' : address })
  }
  return listeners
}

/** Every listening TCP socket, or null when netstat couldn't run. */
export async function windowsListeners(): Promise<WindowsListener[] | null> {
  const netstat = `${system32()}\\netstat.exe`
  const [v4, v6] = await Promise.all([
    run(netstat, ['-ano', '-p', 'TCP'], 5000),
    run(netstat, ['-ano', '-p', 'TCPv6'], 5000),
  ])
  if (v4 === null && v6 === null) return null
  return [...parseNetstat(v4 ?? ''), ...parseNetstat(v6 ?? '')]
}

/** `pid ppid` lines → each process's parent. */
export function parseParents(text: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid && ppid !== undefined && Number.isInteger(ppid)) parents.set(pid, ppid)
  }
  return parents
}

const TABLE_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'

/** Each running process's parent, or null when PowerShell couldn't say. */
export async function readParents(): Promise<Map<number, number> | null> {
  const powershell = `${system32()}\\WindowsPowerShell\\v1.0\\powershell.exe`
  const out = await run(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', TABLE_SCRIPT],
    15_000,
  )
  return out === null ? null : parseParents(out)
}

let table: Map<number, number> | null = null
let listening = new Set<number>()

/**
 * The process table, read again only when one of `pids` (listening processes) wasn't
 * listening the last time: a new server, or a reused pid, which would have stopped
 * listening (its process exited) before Windows gave the pid out again.
 */
async function parentsFor(pids: number[]) {
  const stale = table === null || pids.some((pid) => !listening.has(pid))
  listening = new Set(pids)
  if (stale) table = (await readParents()) ?? table
  return table
}

/** `root` and every process descended from it in `parents`. */
export function descendantsIn(parents: Map<number, number>, root: number): Set<number> {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of parents) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  const found = new Set([root])
  const stack = [root]
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (!found.has(child)) {
        found.add(child)
        stack.push(child)
      }
    }
  }
  return found
}

/**
 * Stands in for a process group: the ancestor of `pid` that Gui itself started (whose
 * parent is `self`), as a dev server's shell is; else `pid`.
 */
export function leaderIn(parents: Map<number, number>, pid: number, self: number) {
  const seen = new Set<number>()
  for (let current = pid; !seen.has(current); ) {
    seen.add(current)
    const parent = parents.get(current)
    if (parent === undefined || parent === 0) break
    if (parent === self) return current
    current = parent
  }
  return pid
}

/** Listeners held by `root` or anything descended from it; null when netstat can't run. */
export async function windowsListenersOf(root: number): Promise<WindowsListener[] | null> {
  const all = await windowsListeners()
  if (all === null) return null
  const parents = await parentsFor([...new Set(all.map((l) => l.pid))])
  const tree = parents ? descendantsIn(parents, root) : new Set([root])
  return all.filter((listener) => tree.has(listener.pid))
}

/** Each pid's stand-in group (`leaderIn`), as ports.ts `processGroups` gives on a Mac. */
export async function windowsGroups(pids: number[]): Promise<Map<number, number>> {
  if (table === null || pids.some((pid) => !table?.has(pid))) table = (await readParents()) ?? table
  const parents = table
  const groups = new Map<number, number>()
  for (const pid of pids) groups.set(pid, parents ? leaderIn(parents, pid, process.pid) : pid)
  return groups
}
