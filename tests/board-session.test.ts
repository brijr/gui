import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test('BoardSession races and lifecycle with isolated platform stubs', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'board-session.ts'),
  ])
  expect(result.stdout).toContain('close/open passed')
  expect(result.stderr).toBe('')
}, 10_000)

test('offscreen renderers stop painting and unload before returning idle', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'board-offscreen.ts'),
  ])
  expect(result.stdout).toContain('cancellation passed')
  expect(result.stderr).toBe('')
}, 10_000)
