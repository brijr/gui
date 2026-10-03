import { spawnSync } from 'node:child_process'

const LSOF = '/usr/sbin/lsof'

function lsof(args: string[]): string {
  const result = spawnSync(LSOF, args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30_000,
  })
  // lsof exits 1 when nothing matches or a file was unreadable; stdout is still authoritative.
  return result.stdout ?? ''
}

/** Pids of processes whose working directory is `root` or somewhere inside it. */
export function pidsInDirectory(root: string): number[] {
  const pids: number[] = []
  let pid = 0
  for (const line of lsof(['-nP', '-d', 'cwd', '-Fpn']).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) {
      const path = line.slice(1)
      if (path === root || path.startsWith(`${root}/`)) pids.push(pid)
    }
  }
  return pids
}

function listeningPids(): Set<number> {
  const pids = new Set<number>()
  for (const line of lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fp']).split('\n')) {
    if (line.startsWith('p')) pids.add(Number(line.slice(1)))
  }
  return pids
}

/**
 * Dev servers that were started from `root`: processes living in that directory that
 * accept TCP connections. The app runs the dev script with the project as its cwd, so
 * this finds Vite and Next (and any child they fork) without knowing their argv.
 */
export function devServerPids(root: string): number[] {
  const listening = listeningPids()
  return pidsInDirectory(root).filter((pid) => listening.has(pid))
}

export function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}
