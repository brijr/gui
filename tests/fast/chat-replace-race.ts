// Isolated process: the Electron stub must not replace modules used by other fast tests.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedChat } from '../../src/main/history'

const userData = await mkdtemp(join(tmpdir(), 'gui-chat-replace-race-'))
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

const history = await import('../../src/main/history')
const { ChatController } = await import('../../src/main/chat')

const X = 'aaaaaaaa-0000-4000-8000-000000000001'
const O = 'bbbbbbbb-0000-4000-8000-000000000002'
const turnOf = (id: string) => `${id.slice(0, 8)}-turn`

/** A chat of one finished turn that changed `a.txt`. */
function saved(id: string, prompt: string): SavedChat {
  const turnId = turnOf(id)
  return {
    version: 1,
    id,
    createdAt: 1,
    agentId: 'claude',
    sessionId: null,
    checkpoints: { [turnId]: { before: `${turnId}-before`, after: `${turnId}-after` } },
    redo: null,
    turns: [
      {
        id: turnId,
        index: 0,
        prompt,
        context: [],
        items: [],
        status: 'done',
        error: null,
        reverted: false,
        startedAt: 1,
        endedAt: 2,
        changes: [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 1 }],
      },
    ],
  }
}

let projects = 0
async function open(chat: SavedChat) {
  const root = join(userData, `project-${++projects}`)
  await mkdir(root, { recursive: true })
  const file = await history.claimHistoryFile(root)
  const controller = new ChatController(root, {} as never, {
    agentId: 'claude',
    docked: false,
    saved: chat,
    historyFile: file,
    recordings: { retain: noop, attachments: async () => [] } as never,
    mcpServers: () => [],
    viewport: () => null,
    startupReport: () => '',
  })
  return {
    root,
    chat: controller,
    internals: controller as unknown as { lock: object | null },
    prompts: () => controller.snapshot().turns.map((turn) => turn.prompt),
    archived: async () => (await history.listArchived(root)).map((each) => each.id),
    async close() {
      await controller.dispose()
      history.releaseHistoryFile(file)
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

try {
  // Opening an archived chat, then New chat (or an agent switch) before the open chat is archived.
  {
    const tab = await open(saved(O, 'The open chat'))
    assert.ok(await history.archiveChat(tab.root, saved(X, 'The archived chat')))
    const opening = tab.chat.openArchived(X)
    while (!tab.internals.lock) await new Promise((resolve) => setImmediate(resolve))
    const resetting = tab.chat.reset()
    await opening
    assert.equal(await resetting, true)
    await settle()
    // New chat came last: the chat is empty, and both transcripts are in the archive.
    assert.deepEqual(tab.prompts(), [])
    assert.deepEqual((await tab.archived()).sort(), [X, O])
    assert.equal((await history.loadArchived(tab.root, X))?.turns[0]?.prompt, 'The archived chat')
    assert.equal(tab.internals.lock, null)
    await tab.close()
    console.log('Overlapping replacements passed.')
  }
} finally {
  await rm(userData, { recursive: true, force: true })
}
