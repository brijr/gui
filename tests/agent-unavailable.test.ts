import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

// The cases are in tests/fast/agent-unavailable.ts, a test file of its own: to read them one by
// one, `bun test ./tests/fast/agent-unavailable.ts`.
test('agent_unavailable says whether the agent was in use and why, with isolated stubs', async () => {
  const file = join(import.meta.dirname, 'fast', 'agent-unavailable.ts')
  const result = await promisify(execFile)(process.execPath, ['test', file]).catch(
    (error: { stdout: string; stderr: string }) => error,
  )
  // The whole report, so a failure in there is shown here.
  const report = `${result.stdout}${result.stderr}`
  expect(report).toContain('\n 0 fail\n')
  expect(report).toMatch(/\n \d+ pass\n/)
}, 10_000)
