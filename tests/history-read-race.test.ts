import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('history read failures cannot move or overwrite a newer replacement', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'history-read-race.ts'),
  ])
  expect(result.stdout).toContain('replacement retention and malformed recovery passed')
  expect(result.stderr).toBe('')
}, 10_000)
