import { mock } from 'bun:test'

// Loaded before every `bun test` file (bunfig.toml). Bun fixes a mocked module's export
// names the first time something imports it; a later mock.module of the same module only
// replaces the values of names it already has. So the first stand-in imported in a run
// decides what every later test file can import, and one that leaves a name out breaks
// some other file depending on the order files run in. This stand-in names every export
// src/ imports and is imported here, first, so a test file's own stand-in only has to give
// what it uses. tests/electron-stand-in.test.ts checks the list against src/.
const noop = () => {}

export const ELECTRON_EXPORTS = {
  app: { isPackaged: false, on: noop },
  autoUpdater: { on: noop },
  BrowserWindow: class {},
  ClipboardItem: class {},
  clipboard: {},
  contextBridge: {},
  dialog: {},
  ipcMain: { on: noop, handle: noop },
  ipcRenderer: {},
  Menu: {},
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) },
  nativeTheme: { on: noop, shouldUseDarkColors: false },
  net: {},
  powerMonitor: { on: noop },
  powerSaveBlocker: {},
  protocol: { registerSchemesAsPrivileged: noop, handle: noop },
  safeStorage: {},
  screen: {},
  session: {},
  shell: {},
  systemPreferences: {},
  WebContentsView: class {},
  webContents: {},
}

mock.module('electron', () => ELECTRON_EXPORTS)
await import('electron')
