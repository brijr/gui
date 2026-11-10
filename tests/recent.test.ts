import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('a damaged recent-projects.json keeps its good entries and never stops the start screen', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'recent.ts'),
  ])
  expect(result.stdout).toContain('Damaged recent projects passed.')
  expect(result.stderr).toBe('')
}, 10_000)
