// Isolated process: the Electron stub must not replace modules used by other fast tests.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedChat } from '../../src/main/history'
import type { AgentHealth, AgentId, ModelSettings } from '../../src/shared/types'

const userData = await mkdtemp(join(tmpdir(), 'gui-chat-agent-check-'))
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

const history = await import('../../src/main/history')
const { agentHealth } = await import('../../src/main/agent-status')
const { flushPrefsSync, saveAgentSetting } = await import('../../src/main/prefs')
const { ChatController } = await import('../../src/main/chat')

// A chat restored on an agent that wasn't checked this launch (anything but Claude Code, Codex
// and the default agent) has no models until its check lists them: without one, its picker
// listed agents alone until the next message started a session.

/** Stands in for a check: says it's checking, and leaves the result to the test. */
const checked: AgentId[] = []
const store = agentHealth as unknown as {
  check: (id: AgentId) => Promise<void>
  set: (id: AgentId, patch: Partial<AgentHealth>) => void
}
store.check = (id) => {
  checked.push(id)
  store.set(id, { status: 'checking' })
  return Promise.resolve()
}

const MODELS: ModelSettings = {
  model: {
    id: 'model',
    value: 'opencode/big-pickle',
    options: [
      { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle', group: null },
      { value: 'fireworks-ai/kimi', name: 'Fireworks AI/Kimi K3.1 Pro', group: null },
    ],
  },
  effort: {
    id: 'effort',
    value: 'default',
    options: [
      { value: 'default', name: 'Default', group: null },
      { value: 'max', name: 'Max', group: null },
    ],
  },
  provider: null,
}

/** A started chat on `agentId`: one finished turn, and the session it had. */
function saved(agentId: AgentId): SavedChat {
  return {
    version: 1,
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    createdAt: 1,
    agentId,
    sessionId: 'ses_old',
    checkpoints: {},
    redo: null,
    turns: [
      {
        id: 'turn-1',
        index: 0,
        prompt: 'Change the heading',
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
    toolAccess: () => null,
    viewport: () => null,
    startupReport: () => '',
  })
  return {
    meta: () => controller.snapshot().meta,
    async close() {
      await controller.dispose()
      history.releaseHistoryFile(file)
    },
  }
}

try {
  saveAgentSetting('opencode', 'model', 'fireworks-ai/kimi')
  const tab = await open(saved('opencode'))
  // Opening it checks its agent; until that's done there's no list, and the chat says so.
  assert.deepEqual(checked, ['opencode'])
  assert.equal(tab.meta().models, null)
  assert.equal(tab.meta().agent?.status, 'checking')
  // Then the check's models, with the user's saved choice on.
  store.set('opencode', { status: 'ready', models: MODELS })
  assert.equal(tab.meta().models?.model.options.length, 2)
  assert.equal(tab.meta().models?.model.value, 'fireworks-ai/kimi')
  assert.equal(tab.meta().models?.effort?.value, 'default')
  await tab.close()

  // Checked already: another chat on it lists them at once, without checking again.
  const again = await open(saved('opencode'))
  assert.equal(again.meta().models?.model.value, 'fireworks-ai/kimi')
  assert.deepEqual(checked, ['opencode'])
  await again.close()
  console.log('A restored chat checks its agent passed.')
  flushPrefsSync()
} finally {
  // The agents' models are saved as the check lands them: let that write finish before its
  // folder goes.
  agentHealth.dispose()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(userData, { recursive: true, force: true })
}
