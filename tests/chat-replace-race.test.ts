import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('a chat keeps its own turns when New chat or a reopened chat overlaps another change', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'chat-replace-race.ts'),
  ])
  expect(result.stdout).toContain('Overlapping replacements passed.')
  expect(result.stdout).toContain('Undo across a new chat passed.')
  expect(result.stdout).toContain('Redo across a reopened chat passed.')
  expect(result.stderr).toBe('')
}, 10_000)
