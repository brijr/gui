import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import type { AgentBinaries, AgentBinary } from '../../scripts/agent-binaries'
import { type AgentBinarySource, type AgentId, agentName } from '../shared/types'
import { getShellEnv } from './shell-env'

declare const __GRAT_AGENT_BINARIES__: AgentBinaries

const REGISTRY = 'https://registry.npmjs.org'
const VERSION_TIMEOUT_MS = 10_000
const DOWNLOAD_STALL_MS = 60_000
/** Where installers put the CLIs, for when the login shell's PATH doesn't cover them. */
const COMMON_BIN_DIRS = ['.local/bin', '.claude/local', '.npm-global/bin', '.bun/bin']
const SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const COMMANDS = { claude: 'claude', codex: 'codex' } as const

/** The agents whose CLI Grat pins (and can download); other agents bring their own. */
export type PinnedAgentId = keyof typeof COMMANDS

export function pinnedAgent(id: AgentId): PinnedAgentId | null {
  return id === 'claude' || id === 'codex' ? id : null
}

/** An agent CLI Grat can run, and where it came from. */
export interface ResolvedBinary {
  path: string
  version: string
  source: AgentBinarySource
}

export type BinaryStatus =
  | { kind: 'ready'; binary: ResolvedBinary }
  /** `found` is the user's own CLI when it's too old (or too new) for Grat's adapter. */
  | {
      kind: 'missing'
      found: { path: string; version: string } | null
      /** Whether `found` is older or newer than the versions Grat's adapter supports */
      mismatch: 'older' | 'newer' | null
    }

export class AgentMissingError extends Error {}


/**
 * The pinned CLI for this Mac. Unpackaged builds (dev, e2e) may swap the manifest via
 * GRAT_AGENT_MANIFEST to install from a local registry; packaged builds never do.
 */
async function pinned(id: PinnedAgentId): Promise<AgentBinary> {
  let binaries = __GRAT_AGENT_BINARIES__
  const override = !app.isPackaged ? process.env.GRAT_AGENT_MANIFEST : undefined
  if (override) binaries = JSON.parse(await readFile(override, 'utf8')) as AgentBinaries
  const spec = binaries[id][`${process.platform}-${process.arch}`]
  if (!spec) throw new Error(`${agentName(id)} isn't available for this Mac.`)
  return spec
}

function registry() {
  return (!app.isPackaged && process.env.GRAT_AGENT_REGISTRY) || REGISTRY
}

const agentsDir = () => join(app.getPath('userData'), 'agents')
const installDir = (id: PinnedAgentId, spec: AgentBinary) => join(agentsDir(), id, spec.version)

function parseVersion(text: string) {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * The adapters drive their CLI over an evolving protocol: accept the user's own CLI
 * only from the same minor line, at or above the version the adapter needs.
 */
function compatible(version: string, spec: AgentBinary) {
  const have = parseVersion(version)
  const min = parseVersion(spec.minCliVersion)
  const line = parseVersion(spec.cliVersion)
  if (!have || !min || !line) return false
  return have[0] === line[0] && have[1] === line[1] && have[2] >= min[2]
}

function mismatch(version: string, spec: AgentBinary): 'older' | 'newer' {
  const have = parseVersion(version) ?? [0, 0, 0]
  const min = parseVersion(spec.minCliVersion) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    if (have[i] !== min[i]) return (have[i] ?? 0) < (min[i] ?? 0) ? 'older' : 'newer'
  }
  return 'newer'
}

async function isExecutable(path: string) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function cliVersion(path: string, env: NodeJS.ProcessEnv) {
  return new Promise<string | null>((resolve) => {
    execFile(path, ['--version'], { timeout: VERSION_TIMEOUT_MS, env }, (error, stdout) => {
      const version = error ? null : parseVersion(stdout)
      resolve(version ? version.join('.') : null)
    })
  })
}

/** The user's own install: first on their login-shell PATH, then where installers put it. */
async function findInstalled(id: PinnedAgentId) {
  const env = await getShellEnv()
  const home = homedir()
  const dirs = [
    ...(env.PATH ?? '').split(delimiter),
    ...COMMON_BIN_DIRS.map((dir) => join(home, dir)),
    ...SYSTEM_BIN_DIRS,
  ]
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const path = join(dir, COMMANDS[id])
    if (!(await isExecutable(path))) continue
    const version = await cliVersion(path, env)
    if (version) return { path, version }
  }
  return null
}

async function resolve(id: PinnedAgentId): Promise<BinaryStatus> {
  const spec = await pinned(id)
  // An exact copy Grat installed always matches its adapter.
  const own = join(installDir(id, spec), 'package', spec.bin)
  if (await isExecutable(own)) {
    return { kind: 'ready', binary: { path: own, version: spec.cliVersion, source: 'grat' } }
  }
  const found = await findInstalled(id)
  if (found && compatible(found.version, spec)) {
    return { kind: 'ready', binary: { ...found, source: 'yours' } }
  }
  if (!app.isPackaged) {
    const dev = join(app.getAppPath(), 'node_modules', spec.devDir, spec.bin)
    if (await isExecutable(dev)) {
      return { kind: 'ready', binary: { path: dev, version: spec.cliVersion, source: 'bundled' } }
    }
  }
  return { kind: 'missing', found, mismatch: found ? mismatch(found.version, spec) : null }
}

const resolutions = new Map<PinnedAgentId, Promise<BinaryStatus>>()

/** Which CLI an agent would run with. Cached; `forgetBinaries` re-checks. */
export function agentBinary(id: PinnedAgentId): Promise<BinaryStatus> {
  let resolution = resolutions.get(id)
  if (!resolution) {
    resolution = resolve(id)
    resolutions.set(id, resolution)
    resolution.catch(() => resolutions.delete(id))
  }
  return resolution
}

export function forgetBinaries(id?: PinnedAgentId) {
  if (id) resolutions.delete(id)
  else resolutions.clear()
}

/** The CLI to run, or an error saying what's needed when there's none. */
export async function requireAgentBinary(id: PinnedAgentId): Promise<ResolvedBinary> {
  const status = await agentBinary(id)
  if (status.kind === 'ready') return status.binary
  throw new AgentMissingError(missingMessage(id, status))
}

export function missingMessage(id: PinnedAgentId, status: Extract<BinaryStatus, { kind: 'missing' }>) {
  const name = agentName(id)
  if (!status.found) return `${name} isn't installed yet. Grat can set it up for you.`
  const age = status.mismatch === 'newer' ? 'newer' : 'older'
  return `Your ${name} (${status.found.version}) is ${age} than Grat supports. Grat can install its own copy; yours stays as it is.`
}

export interface InstallProgress {
  received: number
  /** null when the server doesn't say */
  total: number | null
}

/**
 * Downloads the exact CLI Grat's adapter was built against from npm, checks it against
 * the hash pinned from bun.lock, and unpacks it into Grat's data folder. Nothing outside
 * that folder changes; a user's own install is left alone.
 */
export async function installAgentBinary(
  id: PinnedAgentId,
  onProgress: (progress: InstallProgress) => void,
  signal: AbortSignal,
) {
  const spec = await pinned(id)
  const root = join(agentsDir(), id)
  await mkdir(root, { recursive: true })
  // Leftovers from an install interrupted by a quit or crash.
  for (const entry of await readdir(root)) {
    if (entry.startsWith('.')) await rm(join(root, entry), { recursive: true, force: true })
  }
  const tag = randomBytes(6).toString('hex')
  const archive = join(root, `.download-${tag}.tgz`)
  const staging = join(root, `.unpack-${tag}`)
  try {
    const name = spec.package.split('/').at(-1) ?? spec.package
    const url = `${registry()}/${spec.package}/-/${name}-${spec.version}.tgz`
    const response = await fetch(url, { signal })
    if (!response.ok || !response.body) {
      throw new Error(`Couldn't download ${agentName(id)} (${response.status}).`)
    }
    const length = Number(response.headers.get('content-length'))
    const total = Number.isFinite(length) && length > 0 ? length : null
    const hash = createHash('sha512')
    let received = 0
    let stall: NodeJS.Timeout | undefined
    const stalled = new AbortController()
    const resetStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => stalled.abort(), DOWNLOAD_STALL_MS)
    }
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        received += chunk.length
        resetStall()
        onProgress({ received, total })
        callback(null, chunk)
      },
    })
    resetStall()
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        meter,
        createWriteStream(archive, { mode: 0o600 }),
        { signal: AbortSignal.any([signal, stalled.signal]) },
      )
    } catch (error) {
      if (stalled.signal.aborted && !signal.aborted) {
        throw new Error('The download stopped responding. Check your connection and try again.')
      }
      throw error
    } finally {
      clearTimeout(stall)
    }
    if (`sha512-${hash.digest('base64')}` !== spec.integrity) {
      throw new Error(
        `The ${agentName(id)} download didn't match its expected checksum, so Grat didn't install it.`,
      )
    }

    await mkdir(staging)
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/tar', ['-xzf', archive, '-C', staging], (error) =>
        error ? reject(new Error(`Couldn't unpack ${agentName(id)}: ${error.message}`)) : resolve(),
      )
    })
    if (!(await isExecutable(join(staging, 'package', spec.bin)))) {
      throw new Error(`The ${agentName(id)} package doesn't contain ${spec.bin}.`)
    }
    const target = installDir(id, spec)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    // Older versions Grat installed are no longer used.
    for (const entry of await readdir(root)) {
      if (entry !== spec.version && !entry.startsWith('.')) {
        await rm(join(root, entry), { recursive: true, force: true })
      }
    }
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
    forgetBinaries(id)
  }
}
