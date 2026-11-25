// Isolated process: the Electron stub must not replace modules used by other fast tests.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from '../../src/main/process'

const base = await realpath(await mkdtemp(join(tmpdir(), 'gui-chat-theme-edit-')))
const userData = join(base, 'user-data')
await mkdir(join(base, 'home'), { recursive: true })
class Stub extends EventEmitter {}
const noop = () => undefined
mock.module('electron', () => ({
  app: Object.assign(new Stub(), {
    isPackaged: false,
    getPath: () => userData,
    getAppPath: () => userData,
    getVersion: () => '0.0.0',
    whenReady: () => new Promise(noop),
  }),
  BrowserWindow: class extends Stub {
    static getAllWindows = () => []
    static getFocusedWindow = () => null
  },
  dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: noop },
  shell: { openExternal: async () => undefined, showItemInFolder: noop },
  net: { fetch: async () => new Response('{}') },
  powerMonitor: new Stub(),
  powerSaveBlocker: {},
  autoUpdater: new Stub(),
  nativeImage: {
    createFromBuffer: () => ({}),
    createFromDataURL: () => ({}),
    createEmpty: () => ({}),
  },
  nativeTheme: Object.assign(new Stub(), { shouldUseDarkColors: false }),
  safeStorage: { isEncryptionAvailable: () => false },
  Menu: { buildFromTemplate: () => ({ popup: noop }) },
  clipboard: {},
  ipcMain: new Stub(),
  protocol: {},
  screen: {},
  session: {},
  systemPreferences: {},
  webContents: {},
  WebContentsView: class {},
  View: class {},
}))
// Git runs with this process's environment, as in checkpoints.test.ts.
mock.module('../../src/main/shell-env', () => ({
  getShellEnv: async () => ({ PATH: process.env.PATH }),
  addToPath: async () => {},
}))

const history = await import('../../src/main/history')
const { ChatController } = await import('../../src/main/chat')
const { Checkpoints } = await import('../../src/main/checkpoints')
const { writeThemeEdits } = await import('../../src/main/theme-source')

/** macOS's `/usr/bin/git` only finds the real one. */
function realGitDir() {
  try {
    return dirname(execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim())
  } catch {
    return null
  }
}
const env = {
  PATH: [realGitDir(), process.env.PATH].filter(Boolean).join(':'),
  HOME: join(base, 'home'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

const CSS =
  ':root {\n  --brand: #2563eb;\n  --muted: #64748b;\n}\n\n.dark {\n  --brand: #60a5fa;\n}\n'
const MODES = [
  { id: 'default', label: 'Default', selector: ':root', how: { kind: 'root' as const } },
  { id: 'dark', label: 'Dark', selector: '.dark', how: { kind: 'class' as const, name: 'dark' } },
]
const EDITS = [
  {
    name: '--brand',
    mode: 'default',
    before: '#2563eb',
    after: '#7c3aed',
    file: 'app/globals.css',
  },
  { name: '--brand', mode: 'dark', before: '#60a5fa', after: '#a78bfa', file: 'app/globals.css' },
]

let projects = 0
async function open() {
  const root = join(base, `project-${++projects}`)
  await mkdir(join(root, 'app'), { recursive: true })
  await writeFile(join(root, 'app', 'globals.css'), CSS)
  const store = new Checkpoints(root, join(userData, 'checkpoints'), env)
  await store.init()
  const file = await history.claimHistoryFile(root)
  const controller = new ChatController(root, store as never, {
    agentId: 'claude',
    docked: false,
    saved: null,
    historyFile: file,
    recordings: { retain: noop, attachments: async () => [] } as never,
    toolAccess: () => null,
    viewport: () => null,
    startupReport: () => '',
  })
  const write = () =>
    writeThemeEdits(
      root,
      EDITS.map(({ name, mode, after }) => ({ name, mode, value: after })),
      MODES,
    ).then((result) => result.ok)
  return {
    root,
    chat: controller,
    internals: controller as unknown as { lock: object | null },
    css: () => readFile(join(root, 'app', 'globals.css'), 'utf8'),
    write,
    async close() {
      await controller.dispose()
      history.releaseHistoryFile(file)
    },
  }
}

try {
  {
    const tab = await open()
    // Each reads the theme again, so the preview shows what the files now say.
    let changed = 0
    tab.chat.on('filesChanged', () => changed++)
    assert.equal(await tab.chat.writeThemeEdits(EDITS, tab.write), true)
    assert.equal(changed, 1)
    const turns = tab.chat.snapshot().turns
    assert.equal(turns.length, 1)
    const [turn] = turns
    assert.equal(turn.prompt, 'Changed the theme.')
    assert.equal(turn.status, 'done')
    assert.equal(turn.themeEdits?.length, 2)
    assert.deepEqual(
      turn.changes?.map((change) => change.path),
      ['app/globals.css'],
    )
    assert.match(await tab.css(), /--brand: #7c3aed;[\s\S]*--brand: #a78bfa;/)
    console.log('Keep records one turn passed.')

    await tab.chat.restoreTurn(turn.id)
    assert.equal(await tab.css(), CSS)
    assert.equal(tab.chat.snapshot().turns[0]?.reverted, true)
    assert.equal(changed, 2)
    console.log('Undo restores the CSS passed.')

    await tab.chat.redo()
    assert.match(await tab.css(), /--brand: #7c3aed;/)
    assert.equal(changed, 3)
    console.log('Redo brings it back and reads the theme again passed.')
    await tab.close()
  }

  {
    const tab = await open()
    let changed = 0
    tab.chat.on('filesChanged', () => changed++)
    assert.equal(await tab.chat.writeThemeEdits(EDITS, async () => false), false)
    assert.equal(changed, 0)
    assert.equal(tab.chat.snapshot().turns.length, 0)
    console.log('A refused write records nothing passed.')
    await tab.close()
  }

  {
    const tab = await open()
    tab.internals.lock = {}
    let wrote = false
    const write = async () => {
      wrote = true
      return true
    }
    assert.equal(await tab.chat.writeThemeEdits(EDITS, write), false)
    assert.equal(wrote, false)
    assert.equal(tab.chat.snapshot().turns.length, 0)
    tab.internals.lock = null
    console.log('A running turn refuses Keep passed.')
    await tab.close()
  }
} finally {
  await rm(base, { recursive: true, force: true })
}
