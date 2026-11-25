import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { settleHistory } from '../src/main/history-record'

test('keeping theme changes is one turn of the chat, with Undo', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'chat-theme-edit.ts'),
  ])
  expect(result.stdout).toContain('Keep records one turn passed.')
  expect(result.stdout).toContain('Undo restores the CSS passed.')
  expect(result.stdout).toContain('Redo brings it back and reads the theme again passed.')
  expect(result.stdout).toContain('A refused write records nothing passed.')
  expect(result.stdout).toContain('A running turn refuses Keep passed.')
  expect(result.stderr).toBe('')
}, 20_000)

test('kept theme changes survive a restart; malformed ones are dropped', () => {
  const edit = {
    name: '--brand',
    mode: 'default',
    before: '#2563eb',
    after: '#7c3aed',
    file: 'a.css',
  }
  const turn = (themeEdits: unknown) => ({
    id: 't1',
    prompt: 'Changed the theme.',
    items: [],
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    themeEdits,
  })
  const settled = (themeEdits: unknown) =>
    settleHistory({ version: 1, agentId: 'claude', turns: [turn(themeEdits)] }).turns[0]
  expect(settled([edit, { ...edit, after: 1 }, null]).themeEdits).toEqual([edit])
  expect('themeEdits' in settled('nope')).toBe(false)
  expect('themeEdits' in settled([{ name: '--x' }])).toBe(false)
})
