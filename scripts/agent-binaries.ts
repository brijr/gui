import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The native agent CLI the adapters drive, as published on npm for one platform. */
export interface AgentBinary {
  /** npm package holding the binary, and its exact version */
  package: string
  version: string
  /** Subresource-integrity hash of the package tarball, from bun.lock */
  integrity: string
  /** Executable inside the package */
  bin: string
  /** Where bun installed the package in dev (`node_modules/<dir>`) */
  devDir: string
  /** The CLI version this package contains */
  cliVersion: string
  /** Oldest installed CLI to accept; Claude must also share cliVersion's minor line. */
  minCliVersion: string
}

export type AgentBinaries = Record<'claude' | 'codex', Record<string, AgentBinary>>

const PLATFORMS = [
  { key: 'darwin-arm64', triple: 'aarch64-apple-darwin' },
  { key: 'darwin-x64', triple: 'x86_64-apple-darwin' },
  { key: 'linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  { key: 'linux-x64', triple: 'x86_64-unknown-linux-musl' },
]

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** `"<dir>": ["<name>@<version>", "", { … }, "sha512-…"]` lines in bun.lock */
function lockEntry(lock: string, dir: string) {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const match = lock.match(
    new RegExp(
      `"${escaped}": \\["((?:@[^/"]+/)?[^@"]+)@([^"]+)", "[^"]*", \\{[^\\n]*?\\}, "(sha512-[^"]+)"\\]`,
    ),
  )
  if (!match?.[1] || !match[2] || !match[3]) throw new Error(`bun.lock has no entry for ${dir}`)
  return { package: match[1], version: match[2], integrity: match[3] }
}

/**
 * The oldest installed CLI Gui accepts, set by hand: an adapter bump doesn't move it. Raise
 * one on purpose when a new adapter needs a newer CLI, and say why here.
 *
 * Claude Code 2.1.296 (2026-10-09). For every option claude-agent-acp 0.101.1 sets,
 * claude-agent-sdk 0.3.296 passes Claude Code the same flags, initialize fields and control
 * requests as 0.3.319; each SDK 0.3.N is built for Claude Code 2.1.N. The adapter's
 * cancel handling describes 2.1.293 and 2.1.296; what it reads from newer CLIs (2.1.303+)
 * is optional. Claude Code must also stay on the pinned 2.1 line.
 *
 * Codex 0.164.0 (2026-10-23). codex-acp 2.6.0 calls `thread/sample` on app-server, new in
 * Codex 0.164.0; every other method it calls is older. Its 0.165 and 0.166 bumps only
 * regenerated types: what it reads from them falls back when absent.
 */
const MIN_CLI = { claude: '2.1.296', codex: '0.164.0' }

/** Fails the build when a floor is above its pinned CLI, or (Claude) off its minor line. */
function checkFloor(name: string, floor: string, pinned: string, sameLine: boolean) {
  const f = floor.split('.').map(Number)
  const p = pinned.split('.').map(Number)
  const i = f.findIndex((n, j) => n !== p[j])
  if (i >= 0 && ((f[i] ?? 0) > (p[i] ?? 0) || (sameLine && i < 2))) {
    throw new Error(`The ${name} floor ${floor} doesn't fit the pinned ${pinned}: update MIN_CLI.`)
  }
}

/**
 * Pins the exact agent CLIs Gui's adapters were built against, so Gui can download
 * them (and verify them against bun.lock) instead of shipping 500 MB of binaries.
 */
export function agentBinaries(root: string): AgentBinaries {
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8')
  const modules = join(root, 'node_modules')
  const claudeCli = String(
    readJson(join(modules, '@anthropic-ai/claude-agent-sdk/package.json')).claudeCodeVersion,
  )
  const codexCli = String(readJson(join(modules, '@openai/codex/package.json')).version)
  checkFloor('Claude Code', MIN_CLI.claude, claudeCli, true)
  checkFloor('Codex', MIN_CLI.codex, codexCli, false)

  const binaries: AgentBinaries = { claude: {}, codex: {} }
  for (const { key, triple } of PLATFORMS) {
    const claudeDir = `@anthropic-ai/claude-agent-sdk-${key}`
    binaries.claude[key] = {
      ...lockEntry(lock, claudeDir),
      bin: 'claude',
      devDir: claudeDir,
      cliVersion: claudeCli,
      minCliVersion: MIN_CLI.claude,
    }
    const codexDir = `@openai/codex-${key}`
    binaries.codex[key] = {
      ...lockEntry(lock, codexDir),
      bin: `vendor/${triple}/bin/codex`,
      devDir: codexDir,
      cliVersion: codexCli,
      minCliVersion: MIN_CLI.codex,
    }
  }
  return binaries
}
