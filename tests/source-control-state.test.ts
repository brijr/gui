import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('source control drafts reject stale project results and preserve user edits', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'source-control-state.ts'),
  ])
  expect(result.stdout).toContain('proposal preservation passed')
  expect(result.stderr).toBe('')
}, 10_000)
