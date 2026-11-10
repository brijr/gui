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

/** A chat of one finished turn that changed `a.txt`; `undone` leaves it waiting to be redone. */
function saved(id: string, prompt: string, undone = false): SavedChat {
  const turnId = turnOf(id)
  return {
    version: 1,
    id,
    createdAt: 1,
    agentId: 'claude',
    sessionId: null,
    checkpoints: { [turnId]: { before: `${turnId}-before`, after: `${turnId}-after` } },
    redo: undone ? { sha: `${turnId}-redo`, paths: ['a.txt'], turnIds: [turnId] } : null,
    turns: [
      {
        id: turnId,
        index: 0,
        prompt,
        context: [],
        items: [],
        status: 'done',
        error: null,
        reverted: undone,
        startedAt: 1,
        endedAt: 2,
        changes: [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 1 }],
      },
    ],
  }
}

/** A checkpoint store that records what it restores and can hold one call open. */
function checkpoints() {
  const restored: string[] = []
  let held: { call: 'snapshot' | 'restore'; nth: number; gate: Promise<void> } | null = null
  let reached: () => void = noop
  const counts = { snapshot: 0, restore: 0 }
  const pause = async (call: 'snapshot' | 'restore') => {
    if (held?.call !== call || ++counts[call] !== held.nth) return
    reached()
    await held.gate
  }
  return {
    restored,
    /** Holds the `nth` call open; resolves once it's reached, with what lets it go on. */
    hold(call: 'snapshot' | 'restore', nth: number) {
      let release: () => void = noop
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      held = { call, nth, gate }
      return new Promise<() => void>((resolve) => {
        reached = () => resolve(release)
      })
    },
    store: {
      hasCommits: async () => true,
      snapshot: async (message: string) => {
        await pause('snapshot')
        return `snapshot: ${message}`
      },
      diff: async () => [],
      changedAmong: async () => [],
      restore: async (sha: string) => {
        await pause('restore')
        restored.push(sha)
      },
    },
  }
}

let projects = 0
async function open(chat: SavedChat, store: object = {}) {
  const root = join(userData, `project-${++projects}`)
  await mkdir(root, { recursive: true })
  const file = await history.claimHistoryFile(root)
  const controller = new ChatController(root, store as never, {
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

  // Undo, then New chat while the undo takes its second snapshot (after its last epoch check).
  {
    const files = checkpoints()
    const tab = await open(saved(O, 'The open chat'), files.store)
    const held = files.hold('snapshot', 2)
    const undoing = tab.chat.restoreTurn(turnOf(O))
    const release = await held
    assert.equal(await tab.chat.reset(), true)
    release()
    await undoing
    await settle()
    // The new chat has nothing to redo, and the archived one's files are as it says they are.
    assert.deepEqual(tab.chat.snapshot().meta.redoTurnIds, [])
    assert.deepEqual(files.restored, [])
    assert.equal((await history.loadArchived(tab.root, O))?.turns[0]?.reverted, false)
    await tab.close()
    console.log('Undo across a new chat passed.')
  }

  // Redo, then New chat and an archived chat opened while the redo restores its files.
  {
    const files = checkpoints()
    const tab = await open(saved(O, 'The open chat', true), files.store)
    assert.ok(await history.archiveChat(tab.root, saved(X, 'The archived chat', true)))
    const held = files.hold('restore', 1)
    const redoing = tab.chat.redo()
    const release = await held
    assert.equal(await tab.chat.reset(), true)
    await tab.chat.openArchived(X)
    release()
    await redoing
    await settle()
    // The chat opened meanwhile still has its own undone turn to redo.
    assert.deepEqual(tab.prompts(), ['The archived chat'])
    assert.deepEqual(tab.chat.snapshot().meta.redoTurnIds, [turnOf(X)])
    assert.equal(tab.chat.snapshot().turns[0]?.reverted, true)
    await tab.close()
    console.log('Redo across a reopened chat passed.')
  }
} finally {
  await rm(userData, { recursive: true, force: true })
}
