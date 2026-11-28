import { expect, test } from 'bun:test'
import { agentBinaries } from '../scripts/agent-binaries'
import { compatible, mismatch } from '../src/main/agent-binaries'

// Gui runs the user's own Claude Code or Codex when it is at or above a floor set by hand in
// scripts/agent-binaries.ts (not the exact version Gui pins), and offers its own copy otherwise.

const binaries = agentBinaries('.')
const claude = binaries.claude['darwin-arm64']
const codex = binaries.codex['darwin-arm64']
if (!claude || !codex) throw new Error('no darwin-arm64 pins')

test('the floors are the hand-set ones, below the pinned CLIs', () => {
  expect(claude.minCliVersion).toBe('2.1.296')
  expect(codex.minCliVersion).toBe('0.164.0')
  expect(claude.cliVersion).not.toBe(claude.minCliVersion)
  expect(codex.cliVersion).not.toBe(codex.minCliVersion)
})

test('Claude Code below, at and above its floor', () => {
  expect(compatible('claude', '2.1.295', claude)).toBe(false)
  expect(mismatch('2.1.295', claude)).toBe('older')
  expect(compatible('claude', '2.0.99', claude)).toBe(false)
  expect(compatible('claude', '2.1.296', claude)).toBe(true)
  expect(compatible('claude', '2.1.300 (Claude Code)', claude)).toBe(true)
  expect(compatible('claude', claude.cliVersion, claude)).toBe(true)
  expect(compatible('claude', '2.1.999', claude)).toBe(true)
})

test('a Claude Code past the 2.1 line is too new', () => {
  expect(compatible('claude', '2.2.0', claude)).toBe(false)
  expect(mismatch('2.2.0', claude)).toBe('newer')
  expect(compatible('claude', '3.0.0', claude)).toBe(false)
  expect(mismatch('3.0.0', claude)).toBe('newer')
})

test('Codex below, at and above its floor, with no ceiling', () => {
  expect(compatible('codex', '0.163.0', codex)).toBe(false)
  expect(mismatch('0.163.0', codex)).toBe('older')
  expect(compatible('codex', 'codex-cli 0.164.0', codex)).toBe(true)
  expect(compatible('codex', '0.165.2', codex)).toBe(true)
  expect(compatible('codex', '0.172.0', codex)).toBe(true)
  expect(compatible('codex', '1.0.0', codex)).toBe(true)
})

test('a pre-release counts as its version; output without one is never accepted', () => {
  // `--version` is read as x.y.z, so 0.164.0-alpha.2 is 0.164.0 and 0.163.9-rc is 0.163.9.
  expect(compatible('codex', 'codex-cli 0.164.0-alpha.2', codex)).toBe(true)
  expect(compatible('codex', 'codex-cli 0.163.9-rc.1', codex)).toBe(false)
  expect(compatible('claude', '2.1.296-beta (Claude Code)', claude)).toBe(true)
  expect(compatible('codex', '', codex)).toBe(false)
  expect(compatible('claude', 'claude: command not found', claude)).toBe(false)
  expect(compatible('claude', '2.1', claude)).toBe(false)
})
