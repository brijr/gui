import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findAgentCommand } from '../src/main/executables'

const root = mkdtempSync(join(tmpdir(), 'gui-executables-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A bin directory whose commands are symlinks to programs at the given paths. */
function bin(name: string, links: Record<string, string>) {
  const dir = join(root, name, 'bin')
  mkdirSync(dir, { recursive: true })
  for (const [command, target] of Object.entries(links)) {
    const program = join(root, name, target)
    mkdirSync(join(program, '..'), { recursive: true })
    writeFileSync(program, '#!/bin/sh\n')
    chmodSync(program, 0o755)
    symlinkSync(program, join(dir, command))
  }
  return dir
}

// As Cursor's installer lays it out, and Grok's own `agent`.
const CURSOR = 'share/cursor-agent/versions/2026.11.05/cursor-agent'
const cursor = { command: 'agent', owner: /cursor/i }

describe('findAgentCommand', () => {
  test('prefers cursor-agent, which only Cursor installs', async () => {
    const dir = bin('both', { agent: CURSOR, 'cursor-agent': CURSOR })
    expect(await findAgentCommand('cursor-agent', cursor, dir)).toEqual({
      command: 'cursor-agent',
      path: join(dir, 'cursor-agent'),
    })
  })

  test('falls back to agent when it is Cursor’s', async () => {
    const dir = bin('agent-only', { agent: CURSOR })
    expect(await findAgentCommand('cursor-agent', cursor, dir)).toEqual({
      command: 'agent',
      path: join(dir, 'agent'),
    })
  })

  test('another CLI’s agent is not Cursor', async () => {
    const dir = bin('grok', { agent: 'downloads/grok-1.0.50-macos-aarch64' })
    expect(await findAgentCommand('cursor-agent', cursor, dir)).toBeNull()
    expect(await findAgentCommand('cursor-agent', undefined, dir)).toBeNull()
  })
})
