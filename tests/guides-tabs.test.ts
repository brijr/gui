import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('two tabs on one folder show and save the same guides', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'guides-tabs.ts'),
  ])
  expect(result.stdout).toContain('Guides shared by two tabs passed.')
  expect(result.stderr).toBe('')
}, 10_000)
