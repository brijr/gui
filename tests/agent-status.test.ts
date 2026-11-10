import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

// The cases are in tests/fast/agent-status.ts, a test file of its own: to read them one by
// one, `bun test ./tests/fast/agent-status.ts`.
test('agents switched off in Settings are not checked or said to be, with isolated stubs', async () => {
  const file = join(import.meta.dirname, 'fast', 'agent-status.ts')
  const result = await promisify(execFile)(process.execPath, ['test', file]).catch(
    (error: { stdout: string; stderr: string }) => error,
  )
  // The whole report, so a failure in there is shown here.
  const report = `${result.stdout}${result.stderr}`
  expect(report).toContain('\n 0 fail\n')
  expect(report).toMatch(/\n \d+ pass\n/)
}, 10_000)
