// Isolated process: the Electron stub must not replace modules used by other fast tests.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = await mkdtemp(join(tmpdir(), 'gui-prefs-save-'))
mock.module('electron', () => ({ app: { getPath: () => userData } }))

const { flushPrefsSync, getPrefs, prefsEvents, setPrefs } = await import('../../src/main/prefs')
const { isAutoApprove, setAutoApprove } = await import('../../src/main/auto-approve')

const file = join(userData, 'prefs.json')
const onDisk = () => JSON.parse(readFileSync(file, 'utf8'))
/** Waits for prefs.json to hold what memory does: it's written a moment after a change. */
async function saved() {
  for (let tries = 0; tries < 200; tries++) {
    if (existsSync(file) && readFileSync(file, 'utf8') === JSON.stringify(getPrefs(), null, 2)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('prefs.json never caught up with the preferences in memory')
}

try {
  // A change is there for every reader at once, listeners included; the file isn't written
  // while the caller is still running.
  const heard: boolean[] = []
  prefsEvents.on('change', (prefs) => heard.push(prefs.rulers))
  setPrefs({ rulers: true })
  assert.equal(getPrefs().rulers, true)
  assert.deepEqual(heard, [true])
  assert.equal(existsSync(file), false)
  // Changes made together reach the file together.
  setPrefs({ chatSidebar: true })
  setPrefs({ chatSidebarSide: 'right' })
  await saved()
  assert.deepEqual(
    { rulers: onDisk().rulers, docked: onDisk().chatSidebar, side: onDisk().chatSidebarSide },
    { rulers: true, docked: true, side: 'right' },
  )

  // Auto switched off for a project (the direction a crash mustn't lose) holds at once in
  // memory and is written with no timer to wait for.
  const root = join(userData, 'project')
  setAutoApprove(root, false)
  assert.equal(isAutoApprove(root), false)
  await saved()
  assert.deepEqual(onDisk().askRoots, [root])

  // Quitting right after a change writes it before the process goes.
  setPrefs({ crashReports: false })
  assert.equal(onDisk().crashReports, true)
  flushPrefsSync()
  assert.equal(onDisk().crashReports, false)
  // And with a write already on its way, which then leaves nothing behind.
  setPrefs({ chatSidebarWidth: 444 })
  await Promise.resolve()
  setPrefs({ chatSidebarWidth: 480 })
  flushPrefsSync()
  assert.equal(onDisk().chatSidebarWidth, 480)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(onDisk().chatSidebarWidth, 480)
  assert.deepEqual(readdirSync(userData), ['prefs.json'])
  console.log('Preferences saved in the background passed.')
} finally {
  await rm(userData, { recursive: true, force: true })
}
