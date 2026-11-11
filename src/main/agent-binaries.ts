import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { app } from 'electron'
import type { AgentBinaries, AgentBinary } from '../../scripts/agent-binaries'
import { type AgentBinarySource, type AgentId, agentName } from '../shared/types'
import { type DownloadProgress, download } from './download'
import { DetailedError } from './errors'
import { execFile } from './process'
import { getShellEnv } from './shell-env'

declare const __GUI_AGENT_BINARIES__: AgentBinaries

const REGISTRY = 'https://registry.npmjs.org'
const VERSION_TIMEOUT_MS = 10_000
/** Where installers put the CLIs, for when the login shell's PATH doesn't cover them. */
const COMMON_BIN_DIRS = ['.local/bin', '.claude/local', '.npm-global/bin', '.bun/bin']
const SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const COMMANDS = { claude: 'claude', codex: 'codex' } as const

/** The agents whose CLI Gui pins (and can download); other agents bring their own. */
export type PinnedAgentId = keyof typeof COMMANDS

export function pinnedAgent(id: AgentId): PinnedAgentId | null {
  return id === 'claude' || id === 'codex' ? id : null
}

/** An agent CLI Gui can run, and where it came from. */
export interface ResolvedBinary {
  path: string
  version: string
  source: AgentBinarySource
}

export type BinaryStatus =
  | { kind: 'ready'; binary: ResolvedBinary }
  /** `found` is the user's own CLI when it's too old (or too new) for Gui's adapter. */
  | {
      kind: 'missing'
      found: { path: string; version: string } | null
      /** Whether `found` is older or newer than the versions Gui's adapter supports */
      mismatch: 'older' | 'newer' | null
    }

/** The agent's CLI isn't on this Mac (any longer): it reads as Not installed, never as an error. */
export class AgentMissingError extends DetailedError {
  constructor(message: string, detail: string | null = null) {
    super(message, detail)
  }
}

/**
 * The pinned CLI for this Mac. Unpackaged builds (dev, e2e) may swap the manifest via
 * GUI_AGENT_MANIFEST to install from a local registry; packaged builds never do.
 */
async function pinned(id: PinnedAgentId): Promise<AgentBinary> {
  let binaries = __GUI_AGENT_BINARIES__
  const override = !app.isPackaged ? process.env.GUI_AGENT_MANIFEST : undefined
  if (override) binaries = JSON.parse(await readFile(override, 'utf8')) as AgentBinaries
  const spec = binaries[id][`${process.platform}-${process.arch}`]
  if (!spec) throw new Error(`${agentName(id)} isn't available for this Mac.`)
  return spec
}

function registry() {
  return (!app.isPackaged && process.env.GUI_AGENT_REGISTRY) || REGISTRY
}

const agentsDir = () => join(app.getPath('userData'), 'agents')
const installDir = (id: PinnedAgentId, spec: AgentBinary) => join(agentsDir(), id, spec.version)

function parseVersion(text: string) {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * Codex may use any CLI at or above the adapter's minimum; the agent health check
 * verifies startup. Claude stays on the SDK's minor line.
 */
function compatible(id: PinnedAgentId, version: string, spec: AgentBinary) {
  const have = parseVersion(version)
  const min = parseVersion(spec.minCliVersion)
  const line = parseVersion(spec.cliVersion)
  if (!have || !min || !line) return false
  if (id === 'codex') {
    for (let i = 0; i < 3; i++) {
      if (have[i] !== min[i]) return (have[i] ?? 0) > (min[i] ?? 0)
    }
    return true
  }
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
  // An exact copy Gui installed always matches its adapter.
  const own = join(installDir(id, spec), 'package', spec.bin)
  if (await isExecutable(own)) {
    return { kind: 'ready', binary: { path: own, version: spec.cliVersion, source: 'gui' } }
  }
  const found = await findInstalled(id)
  if (found && compatible(id, found.version, spec)) {
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

export function missingMessage(
  id: PinnedAgentId,
  status: Extract<BinaryStatus, { kind: 'missing' }>,
) {
  const name = agentName(id)
  if (!status.found) return `${name} isn't installed yet. Gui can set it up for you.`
  const age = status.mismatch === 'newer' ? 'newer' : 'older'
  return `Gui needs its own copy of ${name}: yours (${status.found.version}) is ${age} than it supports. Yours stays as it is.`
}

export type InstallProgress = DownloadProgress

/**
 * Downloads the exact CLI Gui's adapter was built against from npm, checks it against
 * the hash pinned from bun.lock, and unpacks it into Gui's data folder. Nothing outside
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
    const digest = await download(url, archive, {
      what: agentName(id),
      algorithm: 'sha512',
      encoding: 'base64',
      onProgress,
      signal,
    })
    if (`sha512-${digest}` !== spec.integrity) {
      throw new Error(
        `The ${agentName(id)} download didn't match its expected checksum, so Gui didn't install it.`,
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
    // Older versions Gui installed are no longer used.
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
