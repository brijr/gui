import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('a chat reopened from the archive survives a New chat that overlaps it', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'chat-replace-race.ts'),
  ])
  expect(result.stdout).toContain('Overlapping replacements passed.')
  expect(result.stderr).toBe('')
}, 10_000)
