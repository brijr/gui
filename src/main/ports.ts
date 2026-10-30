import { connect } from 'node:net'
import { execFile } from './process'

export interface Listener {
  pid: number
  /** Host part of the bound address, e.g. '127.0.0.1', '*', '[::1]', '[::]' */
  host: string
}

/** Its output; null when it couldn't run or timed out. */
function run(command: string, args: string[]) {
  return new Promise<string | null>((resolve) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout) => {
      // lsof exits 1 when nothing matches: it ran, and its output (none) is the answer.
      const ran = !error || (typeof error.code === 'number' && !error.killed)
      resolve(ran || stdout ? String(stdout) : null)
    })
  })
}

/** TCP listeners on a port, or null when lsof isn't available. */
export async function listenersOn(port: number): Promise<Listener[] | null> {
  const out = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'])
  if (out === null) return null
  const listeners: Listener[] = []
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const name = line.slice(1)
      listeners.push({ pid, host: name.slice(0, name.lastIndexOf(':')) })
    }
  }
  return listeners
}

export interface PortListener extends Listener {
  port: number
}

/** `*:5173` → { host: '*', port: 5173 }, as lsof names a listening socket. */
function parseAddress(name: string) {
  const colon = name.lastIndexOf(':')
  const port = Number(name.slice(colon + 1))
  return colon > 0 && Number.isInteger(port) && port > 0
    ? { host: name.slice(0, colon), port }
    : null
}

/**
 * TCP listeners held by the process `root` or anything it started: its descendants, and
 * whatever is in its process group. Null when lsof isn't available.
 */
export async function listenersOf(root: number): Promise<PortListener[] | null> {
  const table = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='])
  const pids = table === null ? [root] : descendants(table, root)
  const args = ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fpn']
  const out = await run('/usr/sbin/lsof', [...args, '-p', pids.join(',')])
  if (out === null) return null
  const listeners: PortListener[] = []
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const address = parseAddress(line.slice(1))
      if (address) listeners.push({ pid, ...address })
    }
  }
  return listeners
}

/** `root`, its descendants, and the members of its process group, from `ps` output. */
function descendants(table: string, root: number): number[] {
  const children = new Map<number, number[]>()
  const found = new Set([root])
  for (const line of table.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (!pid || ppid === undefined) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
    if (pgid === root) found.add(pid)
  }
  const stack = [...found]
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (!found.has(child)) {
        found.add(child)
        stack.push(child)
      }
    }
  }
  return [...found]
}

/** Process group ids for the given pids. */
export async function processGroups(pids: number[]): Promise<Map<number, number>> {
  const groups = new Map<number, number>()
  if (pids.length === 0) return groups
  const out = await run('/bin/ps', ['-o', 'pid=,pgid=', '-p', pids.join(',')])
  for (const line of out?.split('\n') ?? []) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pid && pgid) groups.set(pid, pgid)
  }
  return groups
}

/** Loopback host that reaches a listener bound to `host`. */
export function loopbackFor(host: string) {
  return host.startsWith('[') ? '[::1]' : '127.0.0.1'
}

export function portOpen(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
