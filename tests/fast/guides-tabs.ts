// Isolated process: the Electron stub must not replace modules used by other fast tests.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { RulerGuide } from '../../src/shared/types'

const userData = await mkdtemp(join(tmpdir(), 'gui-guides-tabs-'))
const noop = () => undefined
class Contents extends EventEmitter {
  setWindowOpenHandler = noop
  isDestroyed = () => false
  send = noop
  close = noop
}
mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => userData },
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
  WebContentsView: class {
    webContents = new Contents()
  },
}))
mock.module('../../src/main/renderer', () => ({
  PRELOAD: '',
  guardAppContents: noop,
  loadRenderer: async () => undefined,
}))

const { Guides } = await import('../../src/main/guides')
const { getPrefs } = await import('../../src/main/prefs')

const root = join(userData, 'project')
const x = (at: number): RulerGuide => ({ axis: 'x', at })
const y = (at: number): RulerGuide => ({ axis: 'y', at })
const page = { x: 0, y: 0, width: 800, height: 600 }
/** A tab on the project, its page filling a 800 by 600 canvas. */
function tab(sendChrome: (channel: string, payload: unknown) => void = noop) {
  const guides = new Guides({} as never, {
    inspector: { nodeAt: async () => null } as never,
    scale: () => 1,
    root: () => root,
    sendChrome,
    relayout: noop,
  })
  guides.place(null, page, page)
  return guides
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
/** Waits for prefs.json to hold `guides` for the project: it's written a moment after a change. */
async function saved(guides: RulerGuide[]) {
  let last: unknown
  for (let tries = 0; tries < 100; tries++) {
    last = await readFile(join(userData, 'prefs.json'), 'utf8')
      .then((text) => JSON.parse(text).guides[root])
      .catch(() => undefined)
    if (isDeepStrictEqual(last, guides)) return
    await settle()
  }
  assert.deepEqual(last, guides)
}

try {
  // The same folder open in two tabs, each with the project's guides (none yet) read.
  const a = tab()
  const b = tab()
  assert.deepEqual(a.list(), [])
  assert.deepEqual(b.list(), [])

  // A guide added in each: both tabs show both, and both are saved.
  a.change({ add: [x(100)], remove: [] })
  b.change({ add: [y(50)], remove: [] })
  assert.deepEqual(a.list(), [x(100), y(50)])
  assert.deepEqual(b.list(), [x(100), y(50)])
  await saved([x(100), y(50)])

  // One removed in a tab goes from the other.
  a.change({ add: [], remove: [y(50)] })
  assert.deepEqual(b.list(), [x(100)])
  await saved([x(100)])

  // A guide held mid-drag in one tab while the other changes: let go, both are kept.
  assert.equal(getPrefs().rulers, true)
  b.rulerDrag('y', 'move', { x: 10, y: 200 })
  await settle()
  a.change({ add: [x(300)], remove: [] })
  b.rulerDrag('y', 'end', { x: 10, y: 200 })
  await settle()
  assert.deepEqual(a.list(), [x(100), x(300), y(200)])
  assert.deepEqual(b.list(), [x(100), x(300), y(200)])
  await saved([x(100), x(300), y(200)])

  // The chrome is told what the rulers show as it changes, not again with every layout.
  const told: unknown[] = []
  const c = tab((_channel, view) => told.push(view))
  assert.equal(told.length, 1)
  c.place(null, page, page)
  c.place(null, page, page)
  assert.equal(told.length, 1)
  const narrower = { ...page, width: 700 }
  c.place(null, narrower, page)
  assert.equal(told.length, 2)
  // Rulers drawn anew ask where they are, and hear no more until something changes.
  assert.deepEqual(c.rulers(), told[1])
  c.place(null, narrower, page)
  assert.equal(told.length, 2)
  // Off screen there's nothing to show, which is said once.
  c.place(null, null, page)
  c.place(null, null, page)
  assert.deepEqual(told.slice(2), [null])

  a.dispose()
  b.dispose()
  c.dispose()
  console.log('Guides shared by two tabs passed.')
} finally {
  await rm(userData, { recursive: true, force: true })
}
