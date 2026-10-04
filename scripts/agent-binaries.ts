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
  /** Oldest installed CLI the adapter works with; it must also share the minor version */
  minCliVersion: string
}

export type AgentBinaries = Record<'claude' | 'codex', Record<string, AgentBinary>>

const PLATFORMS = [
  { key: 'darwin-arm64', triple: 'aarch64-apple-darwin' },
  { key: 'darwin-x64', triple: 'x86_64-apple-darwin' },
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
 * Pins the exact agent CLIs Grat's adapters were built against, so Grat can download
 * them (and verify them against bun.lock) instead of shipping 500 MB of binaries.
 */
export function agentBinaries(root: string): AgentBinaries {
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8')
  const modules = join(root, 'node_modules')
  const claudeCli = String(
    readJson(join(modules, '@anthropic-ai/claude-agent-sdk/package.json')).claudeCodeVersion,
  )
  const codexCli = String(readJson(join(modules, '@openai/codex/package.json')).version)
  const codexRange = (
    readJson(join(modules, '@agentclientprotocol/codex-acp/package.json')).dependencies as Record<
      string,
      string
    >
  )['@openai/codex']
  const codexMin = codexRange?.replace(/^[\^~]/, '') ?? codexCli

  const binaries: AgentBinaries = { claude: {}, codex: {} }
  for (const { key, triple } of PLATFORMS) {
    const claudeDir = `@anthropic-ai/claude-agent-sdk-${key}`
    binaries.claude[key] = {
      ...lockEntry(lock, claudeDir),
      bin: 'claude',
      devDir: claudeDir,
      cliVersion: claudeCli,
      minCliVersion: claudeCli,
    }
    const codexDir = `@openai/codex-${key}`
    binaries.codex[key] = {
      ...lockEntry(lock, codexDir),
      bin: `vendor/${triple}/bin/codex`,
      devDir: codexDir,
      cliVersion: codexCli,
      minCliVersion: codexMin,
    }
  }
  return binaries
}
