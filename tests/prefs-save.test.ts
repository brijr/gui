import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('a preference changes at once, its file follows, and quitting writes what is left', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'prefs-save.ts'),
  ])
  expect(result.stdout).toContain('Preferences saved in the background passed.')
  expect(result.stderr).toBe('')
}, 10_000)
