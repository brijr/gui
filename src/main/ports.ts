import { execFile } from 'node:child_process'
import { connect } from 'node:net'

export interface Listener {
  pid: number
  /** Host part of the bound address, e.g. '127.0.0.1', '*', '[::1]', '[::]' */
  host: string
}

function run(command: string, args: string[]) {
  return new Promise<string | null>((resolve) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout) => {
      // lsof exits 1 when nothing matches; treat output as authoritative either way.
      resolve(error && !stdout ? null : stdout)
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
