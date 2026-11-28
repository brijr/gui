import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireVersion } from '../src/main/agent'
import { cliVersion, readCliVersion, VERSION_TIMEOUT_MS } from '../src/main/agent-binaries'
import { agentUnavailable } from '../src/main/analytics-queue'
import { DetailedError, TimeoutError } from '../src/main/errors'

// Gui reads an agent's `--version` before starting it (agent.ts `requireVersion`). A version it
// couldn't read used to count as too old, telling the user to update a CLI that may be current:
// a first `--version` can be slow (Muse's launcher downloads its binary on a first run; agy and
// muse update themselves), and some CLIs print their version and exit non-zero.

const dir = mkdtempSync(join(tmpdir(), 'gui-version-read-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function script(name: string, body: string) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const MUSE = { version: '1.4.23', update: 'muse update' }

test('a slow first --version has half a minute, not ten seconds', () => {
  expect(VERSION_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
})

test('a CLI that takes a while still has a version', async () => {
  const slow = script('slow-muse', 'sleep 1; echo "Muse Code 1.4.25 (1.4.25-R9361.1)"')
  expect(await cliVersion(slow, process.env)).toBe('1.4.25')
})

test('a CLI that prints its version and exits 1 still has a version', async () => {
  const noisy = script('noisy-agy', 'echo 1.5.17; exit 1')
  expect(await cliVersion(noisy, process.env)).toBe('1.5.17')
})

test('one that runs out of time says so', async () => {
  const stuck = script('stuck', 'exec sleep 5')
  const read = await readCliVersion(stuck, process.env, 200)
  expect(read).toMatchObject({ version: null, timedOut: true })
})

test('a version Gui couldn’t read is not too old: the check failed', async () => {
  const silent = script('silent', 'echo "unknown option" >&2; exit 2')
  const error = await requireVersion({ name: 'Muse Code' }, silent, MUSE, process.env).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(DetailedError)
  expect(error).not.toBeInstanceOf(TimeoutError)
  expect((error as Error).message).toBe(
    "Gui couldn't read Muse Code's version, so it didn't start it. It may still be setting itself up. Try again in a moment.",
  )
  expect((error as DetailedError).detail).toContain('exited with code 2')
  expect(agentUnavailable(error)).toBe('error')
})

test('a version below the floor is still too old', async () => {
  const old = script('old-muse', 'echo "Muse Code 1.4.20"')
  const error = await requireVersion({ name: 'Muse Code' }, old, MUSE, process.env).catch(
    (e: unknown) => e,
  )
  expect(agentUnavailable(error)).toBe('too_old')
  expect((error as Error).message).toContain('(yours is 1.4.20)')
})

test('trying again reads the version again', async () => {
  const path = join(dir, 'later')
  script('later', 'exit 1')
  await expect(requireVersion({ name: 'Muse Code' }, path, MUSE, process.env)).rejects.toThrow(
    "couldn't read",
  )
  script('later', 'echo "Muse Code 1.4.25"')
  await expect(requireVersion({ name: 'Muse Code' }, path, MUSE, process.env)).resolves.toBe(
    undefined,
  )
})
