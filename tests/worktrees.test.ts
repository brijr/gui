import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('where to work reads HEAD only, and worktrees are made with their own branch and env files', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'worktrees.ts'),
  ])
  expect(result.stdout).toContain('worktrees passed')
}, 30_000)
