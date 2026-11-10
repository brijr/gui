// Actual recent.ts in a child process: its Electron stub does not affect other test modules.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'gui-recent-'))
mock.module('electron', () => ({
  app: { getPath: () => userData, addRecentDocument() {}, clearRecentDocuments() {} },
}))
const { addRecent, loadRecent, withChats } = await import('../../src/main/recent')

const file = join(userData, 'recent-projects.json')
const good = { root: '/projects/shop', name: 'shop', openedAt: 1 }

try {
  assert.deepEqual(await loadRecent(), [], 'no file')

  // What a crash, a bad disk or a hand edit leaves: only entries that are projects are kept.
  const damaged: Array<[string, unknown[]]> = [
    ['[null]', []],
    [JSON.stringify([null, good]), [good]],
    [JSON.stringify(['/projects/shop', good]), [good]],
    [JSON.stringify([{ name: 'shop', openedAt: 1 }, good]), [good]],
    [JSON.stringify([{ root: 5, name: 'shop' }, { root: '', name: 'shop' }, good]), [good]],
    [JSON.stringify([{ root: '/projects/shop', name: 7 }, good]), [good]],
    [JSON.stringify({ root: '/projects/shop', name: 'shop' }), []],
    ['"/projects/shop"', []],
    ['[{"root": "/projects/shop", "name"', []],
    ['', []],
  ]
  for (const [contents, kept] of damaged) {
    writeFileSync(file, contents)
    assert.deepEqual(await loadRecent(), kept, contents)
  }

  writeFileSync(file, JSON.stringify([null, { root: 5 }, 'x', good]))
  // What a new tab does for its start screen (tab.ts): it threw on the null entry.
  assert.deepEqual(await withChats(await loadRecent()), [{ ...good, chat: null }])
  // Opening a project threw the same way; now it leaves a clean file behind.
  const next = await addRecent({ root: '/projects/blog', name: 'blog' })
  assert.deepEqual(
    next.map((project) => project.root),
    ['/projects/blog', '/projects/shop'],
  )
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), next)
  console.log('Damaged recent projects passed.')
} finally {
  rmSync(userData, { recursive: true, force: true })
}
