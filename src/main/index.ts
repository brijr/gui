import { mkdirSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  session,
  type WebContents,
  webContents,
} from 'electron'
import { Invoke, Send } from '../shared/ipc'
import {
  type CustomAgentEntry,
  type ImageAttachment,
  isAgentId,
  type Rect,
  type SettingsSection,
  type ShipRequest,
  type StorageKind,
  type Viewport,
} from '../shared/types'
import { agentHealth } from './agent-status'
import { agentMenuItems, openCustomAgents } from './agents'
import { isLoopback } from './loopback'
import { getPrefs } from './prefs'
import { loadRecent } from './recent'
import {
  clearRecent,
  confirmAndClear,
  deleteCustom,
  getSettings,
  isSettingsContents,
  openSettings,
  saveCustom,
  setAgentEnabled,
  setChatDocked,
  setDefaultAgent,
  untrustProject,
  watchSettings,
} from './settings'
import { PREVIEW_PARTITION } from './storage'
import { allWindows, findWindow, focusedWindow, ProjectWindow } from './window'

app.setName('Grat')

// Dev builds keep their own data: sharing the installed app's would let both work on one
// project's history and shadow repo at once. Tests pick a folder with --user-data-dir.
// Must run before anything reads userData, including the single-instance lock below.
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  const devData = join(app.getPath('appData'), 'Grat Dev')
  mkdirSync(devData, { recursive: true, mode: 0o700 })
  app.setPath('userData', devData)
}

const VIEWPORTS: readonly Viewport[] = ['desktop', 'tablet', 'mobile']

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Real paths currently being opened, so a double-click can't open one project twice. */
const opening = new Set<string>()

const canonical = (path: string) => realpath(path).catch(() => path)

/** Opens in the given window if it's empty, otherwise in a new window. */
async function openProjectIn(target: ProjectWindow | undefined, root: string) {
  if (!(await isDirectory(root))) {
    dialog.showErrorBox('Project not found', `${root} is not a folder.`)
    return
  }
  const real = await canonical(root)
  const roots = await Promise.all(
    allWindows().map(async (w) => ({ w, root: w.projectRoot && (await canonical(w.projectRoot)) })),
  )
  // Checked and claimed with no await in between.
  const existing = roots.find((entry) => entry.root === real)?.w
  if (existing || opening.has(real)) {
    existing?.win.focus()
    return
  }
  opening.add(real)
  try {
    const empty = target && !target.hasProject ? target : allWindows().find((w) => !w.hasProject)
    await (empty ?? createWindow()).openProject(real)
  } finally {
    opening.delete(real)
  }
}

/** For user-initiated opens: surface failures instead of dropping them. */
function openSafely(target: ProjectWindow | undefined, root: string) {
  openProjectIn(target, root).catch((error: unknown) => {
    dialog.showErrorBox(
      "Couldn't open project",
      error instanceof Error ? error.message : String(error),
    )
  })
}

async function pickProject(target: ProjectWindow | undefined) {
  const parent = target?.win
  const options = {
    title: 'Open project',
    buttonLabel: 'Open',
    properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  const root = result.filePaths[0]
  if (!result.canceled && root) openSafely(target, root)
}

function createWindow() {
  return new ProjectWindow()
}

function windowFor(event: IpcMainEvent | IpcMainInvokeEvent) {
  return findWindow(event.sender)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const SECTIONS: readonly SettingsSection[] = ['agents', 'chat', 'projects', 'storage']
const STORAGE_KINDS: readonly StorageKind[] = ['chats', 'checkpoints', 'previewData']
const isRecordOfStrings = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every(isString)

function isCustomAgentEntry(value: unknown): value is CustomAgentEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    isString(entry.name) &&
    isString(entry.command) &&
    Array.isArray(entry.args) &&
    entry.args.every(isString) &&
    isRecordOfStrings(entry.env)
  )
}

/** Settings themselves are changed from the Settings window only. */
const fromSettings = (event: IpcMainEvent | IpcMainInvokeEvent) => isSettingsContents(event.sender)

/**
 * The Settings window or a project window's own UI (toolbar, start screen), which set
 * agents up. Not the chat panel: it renders what agents write.
 */
const fromAppUi = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  fromSettings(event) || windowFor(event)?.win.webContents === event.sender

/** Errors cross IPC as `{ error }` so the page shows the message without Electron's prefix. */
async function reportError(task: () => Promise<unknown>) {
  try {
    await task()
    return { error: null }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => isNumber(rect[key]))
}

/** What the composer sends: it re-encodes every image, so never a GIF. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_IMAGES = 6
/** The composer keeps images to about 5 MB, under 7 MB as base64; bigger didn't come from it. */
const MAX_IMAGE_BASE64 = 7 * 1024 * 1024
const MAX_THUMBNAIL = 256 * 1024
/** The whole thumbnail, as history accepts it on load (`THUMBNAIL` in history.ts). */
const THUMBNAIL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

function isImage(value: unknown): value is ImageAttachment {
  if (!value || typeof value !== 'object') return false
  const image = value as Record<string, unknown>
  return (
    isString(image.name) &&
    image.name.length <= 200 &&
    isString(image.mimeType) &&
    IMAGE_TYPES.has(image.mimeType) &&
    isString(image.data) &&
    image.data.length <= MAX_IMAGE_BASE64 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) &&
    isString(image.thumbnail) &&
    image.thumbnail.length <= MAX_THUMBNAIL &&
    THUMBNAIL.test(image.thumbnail)
  )
}

function isShipRequest(value: unknown): value is ShipRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return (
    isString(request.branch) &&
    request.branch.length <= 200 &&
    isString(request.title) &&
    request.title.length <= 500 &&
    isString(request.body) &&
    request.body.length <= 20_000
  )
}

function registerIpc() {
  ipcMain.handle(Invoke.getState, (event) => windowFor(event)?.getState())
  ipcMain.handle(Invoke.getLogs, (event) => windowFor(event)?.getLogs() ?? '')
  ipcMain.handle(Invoke.getChat, (event) => windowFor(event)?.getChat())
  ipcMain.handle(Invoke.openProject, (event) => pickProject(windowFor(event)))
  ipcMain.handle(Invoke.openRecent, async (event, root: unknown) => {
    if (!isString(root)) return
    // Only paths the user opened before; anything else goes through the folder picker.
    if (!(await loadRecent()).some((project) => project.root === root)) return
    openSafely(windowFor(event), root)
  })
  ipcMain.handle(Invoke.send, (event, text: unknown, images: unknown) => {
    if (!isString(text)) return false
    const attached = images === undefined ? [] : images
    if (!Array.isArray(attached) || attached.length > MAX_IMAGES || !attached.every(isImage)) {
      return false
    }
    return windowFor(event)?.sendChatMessage(text, attached) ?? false
  })
  ipcMain.handle(Invoke.shipInfo, (event) => windowFor(event)?.getShipInfo() ?? null)
  ipcMain.handle(Invoke.takeScreenshot, (event) => windowFor(event)?.screenshotMenu() ?? null)
  ipcMain.handle(Invoke.ship, (event, request: unknown) => {
    if (!isShipRequest(request)) throw new Error('Invalid request')
    const win = windowFor(event)
    if (!win) throw new Error('No project is open.')
    return win.ship(request)
  })
  ipcMain.handle(Invoke.restoreTurn, (event, turnId: unknown) => {
    if (isString(turnId)) return windowFor(event)?.restoreTurn(turnId)
  })
  ipcMain.handle(Invoke.redo, (event) => windowFor(event)?.redo())
  ipcMain.handle(Invoke.fixProblems, (event) => windowFor(event)?.fixProblems() ?? false)
  ipcMain.handle(Invoke.signIn, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.signIn(agentId)
  })
  ipcMain.handle(Invoke.installAgent, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.install(agentId)
  })

  const on = (channel: string, handler: (win: ProjectWindow, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      const win = windowFor(event)
      if (win) handler(win, ...args)
    })
  }

  on(Send.devServerStart, (win) => win.startDevServer())
  on(Send.devServerStop, (win) => win.stopDevServer())
  on(Send.devServerRestart, (win) => win.restartDevServer())
  on(Send.showDevServerMenu, (win) => win.showDevServerMenu())
  on(Send.showAgentMenu, (win) => win.showAgentMenu(() => openSettings('agents')))
  on(Send.showProjectMenu, (win) =>
    win.showProjectMenu(
      () => void pickProject(win),
      (root) => openSafely(win, root),
    ),
  )
  on(Send.setAgent, (win, agentId) => isAgentId(agentId) && win.setAgent(agentId))

  const handleSettings = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) =>
      fromSettings(event) ? handler(event, ...args) : undefined,
    )
  }
  const onSettings = (channel: string, handler: (...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (fromSettings(event)) handler(...args)
    })
  }
  const onAppUi = (channel: string, handler: (...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (fromAppUi(event)) handler(...args)
    })
  }
  handleSettings(Invoke.getSettings, (event) => getSettings(event.sender))
  handleSettings(Invoke.saveCustomAgent, (_event, originalName, entry) =>
    reportError(async () => {
      if ((originalName !== null && !isString(originalName)) || !isCustomAgentEntry(entry)) {
        throw new Error('That agent entry is malformed.')
      }
      await saveCustom(originalName, entry)
    }),
  )
  handleSettings(Invoke.deleteCustomAgent, (_event, name) =>
    reportError(async () => {
      if (isString(name)) await deleteCustom(name)
    }),
  )
  handleSettings(Invoke.untrustProject, (_event, root) =>
    isString(root) ? untrustProject(root) : undefined,
  )
  handleSettings(Invoke.clearRecent, () => clearRecent())
  handleSettings(Invoke.clearStorage, (_event, kind) =>
    STORAGE_KINDS.includes(kind as StorageKind) ? confirmAndClear(kind as StorageKind) : false,
  )
  onAppUi(Send.openSettings, (section) =>
    openSettings(
      SECTIONS.includes(section as SettingsSection) ? (section as SettingsSection) : undefined,
    ),
  )
  onAppUi(Send.checkAgents, () => void agentHealth.checkAll())
  onAppUi(Send.setAgentEnabled, (agentId, enabled) => {
    if (isAgentId(agentId) && typeof enabled === 'boolean') setAgentEnabled(agentId, enabled)
  })
  onSettings(Send.setDefaultAgent, (agentId) => isAgentId(agentId) && setDefaultAgent(agentId))
  onSettings(Send.setChatDocked, (docked) => typeof docked === 'boolean' && setChatDocked(docked))
  onSettings(Send.openCustomAgentsFile, () => void openCustomAgents())
  on(Send.navigate, (win, url) => isString(url) && win.navigate(url))
  on(Send.back, (win) => win.back())
  on(Send.forward, (win) => win.forward())
  on(Send.reload, (win) => win.reload())
  on(Send.setViewport, (win, viewport) => {
    if (VIEWPORTS.includes(viewport as Viewport)) win.setViewport(viewport as Viewport)
  })
  on(Send.toggleSelect, (win) => void win.toggleSelect())
  on(Send.setCanvasRect, (win, rect) => isRect(rect) && win.setCanvasRect(rect))
  on(Send.toggleChat, (win) => win.toggleChat())
  on(Send.setLogsOpen, (win, open) => win.setLogsOpen(open === true))
  on(Send.resizeLogs, (win, cols, rows) => {
    if (isNumber(cols) && isNumber(rows)) win.resizeLogs(Math.floor(cols), Math.floor(rows))
  })
  on(Send.cancel, (win) => win.cancelChat())
  on(Send.respondPermission, (win, turnId, itemId, optionId) => {
    if (isString(turnId) && isString(itemId) && (optionId === null || isString(optionId))) {
      win.respondPermission(turnId, itemId, optionId)
    }
  })
  on(Send.newSession, (win) => win.newChat())
  on(Send.clearSelection, (win) => win.clearSelection())
  on(Send.setMinimized, (win, minimized) => win.setMinimized(minimized === true))
  on(Send.toggleDock, (win) => win.toggleDock())
  on(Send.dragChat, (win, dx, dy) => isNumber(dx) && isNumber(dy) && win.dragChat(dx, dy))
  on(Send.endDragChat, (win) => win.endDragChat())
  on(Send.resizeChat, (win, dx, dy) => isNumber(dx) && isNumber(dy) && win.resizeChat(dx, dy))
  on(Send.endResizeChat, (win) => win.endResizeChat())
  on(Send.chooseApp, (win, dir) => isString(dir) && win.chooseApp(dir))
  on(Send.installDependencies, (win) => win.installDependencies())
  on(Send.createEnvFile, (win) => win.createEnvFile())
  on(Send.openEnvFile, (win) => win.openEnvFile())
}

/** Permissions the previewed app may use, and only from a local origin. */
const PREVIEW_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])

/**
 * Electron grants every permission unless a handler says otherwise. The preview runs
 * the user's app plus whatever third-party scripts it loads, so deny by default.
 */
function lockDownSessions() {
  const preview = session.fromPartition(PREVIEW_PARTITION)
  preview.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(PREVIEW_PERMISSIONS.has(permission) && isLoopback(details.requestingUrl))
  })
  preview.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return PREVIEW_PERMISSIONS.has(permission) && isLoopback(requestingOrigin)
  })
  preview.setDevicePermissionHandler(() => false)
  preview.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  preview.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault()
    callback('')
  })
  preview.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  // The app's own UI never needs device or media access.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
}

/** Runs in an isolated world, so a previewed page can't fake where focus is. */
const EDITING_TEXT = `(() => {
  const el = document.activeElement
  if (!el) return false
  // The chat box keeps focus after sending; empty, it has no typing to undo.
  if (el.hasAttribute('data-undo-passthrough') && el.value === '') return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type)
})()`

async function isEditingText(wc: WebContents) {
  try {
    return (await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: EDITING_TEXT }])) === true
  } catch {
    return false
  }
}

/**
 * ⌘Z / ⇧⌘Z undo typing while a text field has focus (in Grat or the previewed app);
 * otherwise, including from an empty chat box, they undo or redo the agent's last change.
 */
async function editHistory(direction: 'undo' | 'redo') {
  const wc = webContents.getFocusedWebContents()
  const textEdit = () => (direction === 'undo' ? wc?.undo() : wc?.redo())
  if (wc && !wc.isDestroyed() && (await isEditingText(wc))) return textEdit()
  // With no Grat window focused (e.g. the menu clicked from a script), a lone project
  // window is the only one it can mean.
  const lone = BrowserWindow.getFocusedWindow() === null && allWindows().length === 1
  const win = focusedWindow() ?? (lone ? allWindows()[0] : undefined)
  if (!win) return textEdit()
  await (direction === 'undo' ? win.undoLastChange() : win.redoLastChange())
}

function buildMenu() {
  const withWindow =
    (fn: (win: ProjectWindow) => void): MenuItemConstructorOptions['click'] =>
    () => {
      const win = focusedWindow()
      if (win) fn(win)
    }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickProject(focusedWindow()),
        },
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => void editHistory('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => void editHistory('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Select Element',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: withWindow((w) => void w.toggleSelect()),
        },
        {
          label: 'Toggle Chat',
          accelerator: 'CmdOrCtrl+J',
          click: withWindow((w) => w.toggleChat()),
        },
        {
          label: 'Dock Chat',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: withWindow((w) => w.toggleDock()),
        },
        {
          label: 'Toggle Logs',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: withWindow((w) => w.setLogsOpen(!w.getState().logsOpen)),
        },
        { type: 'separator' },
        {
          label: 'Reload Preview',
          accelerator: 'CmdOrCtrl+R',
          click: withWindow((w) => w.reload()),
        },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: withWindow((w) => w.back()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: withWindow((w) => w.forward()) },
        { type: 'separator' },
        ...VIEWPORTS.map(
          (viewport, i): MenuItemConstructorOptions => ({
            label: `${viewport[0].toUpperCase()}${viewport.slice(1)} Viewport`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: withWindow((w) => w.setViewport(viewport)),
          }),
        ),
        { type: 'separator' },
        {
          label: 'Preview Developer Tools',
          accelerator: 'Alt+CmdOrCtrl+I',
          click: withWindow((w) => w.toggleDevTools()),
        },
        { role: 'toggleDevTools', label: 'App Developer Tools', accelerator: 'Alt+CmdOrCtrl+J' },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        ...agentMenuItems(
          agentHealth.list(),
          agentHealth.customError,
          null,
          (id) => focusedWindow()?.setAgent(id),
          () => openSettings('agents'),
        ),
        { type: 'separator' },
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: withWindow((w) => w.newChat()),
        },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: withWindow((w) => w.cancelChat()) },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function focusExistingWindow() {
  const win = focusedWindow() ?? allWindows()[0]
  if (!win) {
    createWindow()
    return
  }
  if (win.win.isMinimized()) win.win.restore()
  // The user just launched Grat again, so coming to the front is what they asked for.
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.win.focus()
}

/** Stops agent processes that would otherwise outlive the app. */
function shutdown() {
  for (const win of allWindows()) win.destroy()
  agentHealth.dispose()
}

// One Grat per data folder: two would delete each other's live shadow-repo lock and
// overwrite each other's history. The lock is keyed on userData, so a dev build or a
// test with its own --user-data-dir still runs alongside.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusExistingWindow())

  app.on('open-file', (event, path) => {
    event.preventDefault()
    // At cold launch no window is focused yet; reuse the empty one created on ready.
    void app.whenReady().then(() => openSafely(focusedWindow(), path))
  })

  app.whenReady().then(() => {
    lockDownSessions()
    registerIpc()
    watchSettings()
    buildMenu()
    // The Agent menu lists what's installed and signed in.
    agentHealth.on('change', buildMenu)
    // Pick up agents installed (or added to agents.json) while Grat was in the background.
    app.on('browser-window-focus', () => void agentHealth.onAppFocus())
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    const win = createWindow()
    // Know up front whether the likely agents are ready or need sign-in; costs no usage.
    void agentHealth.checkOnLaunch(getPrefs().agentId)
    const initial = process.env.GRAT_OPEN
    if (initial) openSafely(win, resolve(initial))
  })

  app.on('before-quit', shutdown)
  app.on('will-quit', shutdown)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
