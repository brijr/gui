import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs'
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
  isPanelEdge,
  type Rect,
  type SettingsSection,
  type ShipRequest,
  type StorageKind,
  type Viewport,
} from '../shared/types'
import { agentHealth } from './agent-status'
import { agentMenuItems, openCustomAgents } from './agents'
import { offersChoice } from './chat'
import { isLoopback } from './loopback'
import { getPrefs, prefsEvents, setPrefs } from './prefs'
import { findWorkspaceRoot } from './project'
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
import type { ProjectTab } from './tab'
import {
  allTabs,
  allWindows,
  findTab,
  findWindow,
  focusedWindow,
  lastFocusedWindow,
  ProjectWindow,
  windowEvents,
  windowOf,
} from './window'

app.setName('Gui')

/** What a data folder holds once it's been used; a fresh one only has Chromium's files. */
const OWN_DATA = ['prefs.json', 'trusted-projects.json', 'recent-projects.json', 'chats', 'agents']

/** Chromium's SingletonLock points at `<host>-<pid>` while that app is running. */
function inUse(dir: string) {
  try {
    const pid = Number(readlinkSync(join(dir, 'SingletonLock')).split('-').at(-1))
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Gui used to be called Grat. On its first launch, carry Grat's data over (trusted
 * projects, chats and their undo history, downloaded agents, settings), unless Grat is
 * still running or Gui already has data of its own.
 */
function adoptGratData(from: string, to: string) {
  if (!existsSync(from) || inUse(from)) return
  if (OWN_DATA.some((name) => existsSync(join(to, name)))) return
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(from)) {
      // Stale locks stay behind, and anything Gui already made wins.
      if (entry.startsWith('Singleton') || existsSync(join(to, entry))) continue
      renameSync(join(from, entry), join(to, entry))
    }
    const preview = join(to, 'Partitions', 'grat-preview')
    const renamed = join(to, 'Partitions', 'gui-preview')
    if (existsSync(preview) && !existsSync(renamed)) renameSync(preview, renamed)
    rmSync(from, { recursive: true, force: true })
  } catch (error) {
    console.error('[gui] could not carry over Grat data', error)
  }
}

// Dev builds keep their own data: sharing the installed app's would let both work on one
// project's history and shadow repo at once. Tests pick a folder with --user-data-dir.
// Must run before anything reads userData, including the single-instance lock below.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const appData = app.getPath('appData')
  if (app.isPackaged) {
    adoptGratData(join(appData, 'Grat'), app.getPath('userData'))
  } else {
    const devData = join(appData, 'Gui Dev')
    adoptGratData(join(appData, 'Grat Dev'), devData)
    mkdirSync(devData, { recursive: true, mode: 0o700 })
    app.setPath('userData', devData)
  }
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

/**
 * Opens in the window's active tab if it's a start screen, otherwise in a new tab there. With
 * no window given, the focused one (or the one focused last) is used.
 */
async function openProjectIn(target: ProjectWindow | undefined, root: string) {
  if (!(await isDirectory(root))) {
    dialog.showErrorBox('Project not found', `${root} is not a folder.`)
    return
  }
  // A monorepo app's folder opens the monorepo with that app chosen, so installs, the
  // agent and checkpoints work from the root.
  const member = await findWorkspaceRoot(root)
  const real = member?.root ?? (await canonical(root))
  const roots = await Promise.all(
    allTabs().map(async (tab) => ({
      tab,
      root: tab.projectRoot && (await canonical(tab.projectRoot)),
    })),
  )
  // Checked and claimed with no await in between.
  const existing = roots.find((entry) => entry.root === real)?.tab
  if (existing || opening.has(real)) {
    if (existing && member) showApp(existing, member.appDir)
    if (existing) showTab(existing)
    return
  }
  opening.add(real)
  try {
    // The tab reads the app to run from prefs as it opens.
    if (member) setPrefs({ apps: { ...getPrefs().apps, [real]: member.appDir } })
    await tabToOpenIn(target).openProject(real)
  } finally {
    opening.delete(real)
    syncAutoModeItem()
  }
}

/** The window's start-screen tab, or a new tab in it; ⌘N is what makes a new window. */
function tabToOpenIn(target: ProjectWindow | undefined) {
  const live = target && allWindows().includes(target) ? target : undefined
  const win = live ?? lastFocusedWindow() ?? createWindow()
  return win.activeTab.hasProject ? win.newTab() : win.activeTab
}

/** Brings a tab to the front: its window, and the tab in it. */
function showTab(tab: ProjectTab) {
  const win = windowOf(tab)
  if (!win) return
  win.showTab(tab)
  win.win.focus()
}

/**
 * Switches a tab that has the monorepo open to `appDir`, unless it already shows it.
 * A tab still opening keeps what it's opening.
 */
function showApp(tab: ProjectTab, appDir: string) {
  const { project, setup } = tab.getState()
  if (project && (setup?.apps || project.appDir !== appDir)) tab.chooseApp(appDir)
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

/** A chat panel's own tab, or the active tab of the window whose chrome sent it. */
function tabFor(event: IpcMainEvent | IpcMainInvokeEvent) {
  return findTab(event.sender)
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
  ipcMain.handle(Invoke.getLogs, (event) => tabFor(event)?.getLogs() ?? '')
  ipcMain.handle(Invoke.getChat, (event) => tabFor(event)?.getChat())
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
    return tabFor(event)?.sendChatMessage(text, attached) ?? false
  })
  ipcMain.handle(Invoke.shipInfo, (event) => tabFor(event)?.getShipInfo() ?? null)
  ipcMain.handle(Invoke.takeScreenshot, (event) => tabFor(event)?.screenshotMenu() ?? null)
  ipcMain.handle(Invoke.ship, (event, request: unknown) => {
    if (!isShipRequest(request)) throw new Error('Invalid request')
    const tab = tabFor(event)
    if (!tab) throw new Error('No project is open.')
    return tab.ship(request)
  })
  ipcMain.handle(Invoke.restoreTurn, (event, turnId: unknown) => {
    if (isString(turnId)) return tabFor(event)?.restoreTurn(turnId)
  })
  ipcMain.handle(Invoke.redo, (event) => tabFor(event)?.redo())
  ipcMain.handle(Invoke.fixProblems, (event) => tabFor(event)?.fixProblems() ?? false)
  ipcMain.handle(Invoke.signIn, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.signIn(agentId)
  })
  ipcMain.handle(Invoke.installAgent, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.install(agentId)
  })

  /** For the tab the sender acts on (`tabFor`). */
  const on = (channel: string, handler: (tab: ProjectTab, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      const tab = tabFor(event)
      if (tab) handler(tab, ...args)
    })
  }
  /** For the window, from its own chrome only: the canvas and the tab strip. */
  const onWindow = (channel: string, handler: (win: ProjectWindow, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      const win = windowFor(event)
      if (win?.win.webContents === event.sender) handler(win, ...args)
    })
  }

  on(Send.devServerStart, (tab) => tab.startDevServer())
  on(Send.devServerStop, (tab) => tab.stopDevServer())
  on(Send.devServerRestart, (tab) => tab.restartDevServer())
  on(Send.showDevServerMenu, (tab) => tab.showDevServerMenu())
  on(Send.showAgentMenu, (tab) => tab.showAgentMenu(() => openSettings('agents')))
  onWindow(Send.showProjectMenu, (win) =>
    win.activeTab.showProjectMenu(
      () => void pickProject(win),
      (root) => openSafely(win, root),
    ),
  )
  on(Send.setAgent, (tab, agentId) => isAgentId(agentId) && tab.setAgent(agentId))
  onWindow(Send.newTab, (win) => win.newTab())
  onWindow(Send.selectTab, (win, id) => isString(id) && win.selectTab(id))
  onWindow(Send.closeTab, (win, id) => isString(id) && win.closeTab(id))
  onWindow(Send.moveTab, (win, id, index) => {
    if (isString(id) && isNumber(index)) win.moveTab(id, index)
  })
  onWindow(Send.showTabMenu, (win, id) => isString(id) && win.showTabMenu(id))

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
  on(Send.navigate, (tab, url) => isString(url) && tab.navigate(url))
  on(Send.back, (tab) => tab.back())
  on(Send.forward, (tab) => tab.forward())
  on(Send.reload, (tab) => tab.reload())
  on(Send.setViewport, (tab, viewport) => {
    if (VIEWPORTS.includes(viewport as Viewport)) tab.setViewport(viewport as Viewport)
  })
  on(Send.toggleSelect, (tab) => void tab.toggleSelect())
  on(Send.stopSelecting, (tab) => void tab.setSelecting(false))
  onWindow(Send.setCanvasRect, (win, rect) => isRect(rect) && win.setCanvasRect(rect))
  on(Send.toggleChat, (tab) => tab.toggleChat())
  on(Send.setLogsOpen, (tab, open) => tab.setLogsOpen(open === true))
  on(Send.resizeLogs, (tab, cols, rows) => {
    if (isNumber(cols) && isNumber(rows)) tab.resizeLogs(Math.floor(cols), Math.floor(rows))
  })
  on(Send.cancel, (tab) => tab.cancelChat())
  on(Send.removeQueued, (tab, id) => isString(id) && tab.removeQueued(id))
  on(Send.sendQueuedNow, (tab) => tab.sendQueuedNow())
  on(Send.setAutoApprove, (tab, on) => typeof on === 'boolean' && tab.setAutoApprove(on))
  on(Send.setAgentSetting, (tab, settingId, value) => {
    // Only a choice the composer offers right now: the chat panel renders what agents write.
    if (isString(settingId) && isString(value) && offersChoice(tab.chatModels, settingId, value)) {
      tab.setAgentSetting(settingId, value)
    }
  })
  on(Send.respondPermission, (tab, turnId, itemId, optionId) => {
    if (isString(turnId) && isString(itemId) && (optionId === null || isString(optionId))) {
      tab.respondPermission(turnId, itemId, optionId)
    }
  })
  on(Send.newSession, (tab) => tab.newChat())
  on(Send.clearSelection, (tab) => tab.clearSelection())
  on(Send.setMinimized, (tab, minimized) => tab.setMinimized(minimized === true))
  on(Send.toggleDock, (tab) => tab.toggleDock())
  on(Send.dragChat, (tab, dx, dy) => isNumber(dx) && isNumber(dy) && tab.dragChat(dx, dy))
  on(Send.endDragChat, (tab) => tab.endDragChat())
  on(Send.resizeChat, (tab, edge, dx, dy) => {
    if (isPanelEdge(edge) && isNumber(dx) && isNumber(dy)) tab.resizeChat(edge, dx, dy)
  })
  on(Send.endResizeChat, (tab) => tab.endResizeChat())
  on(Send.chooseApp, (tab, dir) => isString(dir) && tab.chooseApp(dir))
  on(Send.installDependencies, (tab) => tab.installDependencies())
  on(Send.createEnvFile, (tab) => tab.createEnvFile())
  on(Send.openEnvFile, (tab) => tab.openEnvFile())
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
 * The window a menu command acts on: the focused one, or with no Gui window focused (e.g.
 * the menu clicked from a script), a lone project window, the only one it can mean.
 */
function menuWindow() {
  const lone = BrowserWindow.getFocusedWindow() === null && allWindows().length === 1
  return focusedWindow() ?? (lone ? allWindows()[0] : undefined)
}

/** The tab a menu command acts on: the active tab of `menuWindow`. */
function menuTab() {
  return menuWindow()?.activeTab
}

/**
 * ⌘Z / ⇧⌘Z undo typing while a text field has focus (in Gui or the previewed app);
 * otherwise, including from an empty chat box, they undo or redo the agent's last change.
 */
async function editHistory(direction: 'undo' | 'redo') {
  const wc = webContents.getFocusedWebContents()
  const textEdit = () => (direction === 'undo' ? wc?.undo() : wc?.redo())
  if (wc && !wc.isDestroyed() && (await isEditingText(wc))) return textEdit()
  const tab = menuTab()
  if (!tab) return textEdit()
  await (direction === 'undo' ? tab.undoLastChange() : tab.redoLastChange())
}

const AUTO_MODE_ITEM = 'auto-mode'

/** Agent → Auto Mode is checked when the project it would change is in Auto mode. */
function syncAutoModeItem() {
  const item = Menu.getApplicationMenu()?.getMenuItemById(AUTO_MODE_ITEM)
  if (item) item.checked = menuTab()?.autoApprove ?? false
}

/** Only from the user's own menu choice or keystroke: agents never get to turn this on. */
function toggleAutoMode() {
  const tab = menuTab()
  tab?.setAutoApprove(!tab.autoApprove)
  // The click already flipped the checkmark; it follows the project's setting instead.
  syncAutoModeItem()
}

/** ⌘T: a start-screen tab in the window menus act on, or a new window when there's none. */
function newTab() {
  const win = menuWindow()
  // A minimized window would hide the tab.
  if (win && !win.win.isMinimized()) win.newTab()
  else createWindow()
}

/** ⌘W: the active tab (a window's last closes it), or another window such as Settings. */
function closeTab() {
  // Detached DevTools (the preview's) isn't a BrowserWindow; ⌘W closes it, not a tab.
  const focused = webContents.getFocusedWebContents()
  const inspected = webContents
    .getAllWebContents()
    .find((wc) => focused && wc.devToolsWebContents?.id === focused.id)
  if (inspected) return inspected.closeDevTools()
  const win = menuWindow()
  if (!win) BrowserWindow.getFocusedWindow()?.close()
  else if (!win.win.isMinimized()) win.closeTab(win.activeTab.id)
}

function buildMenu() {
  /** For the active tab of the window menus act on (`menuTab`): the project it shows. */
  const withWindow =
    (fn: (tab: ProjectTab) => void): MenuItemConstructorOptions['click'] =>
    () => {
      const tab = menuTab()
      if (tab) fn(tab)
    }
  /** For the tabs of the window menus act on (`menuWindow`). */
  const withTabs =
    (fn: (win: ProjectWindow) => void): MenuItemConstructorOptions['click'] =>
    () => {
      const win = menuWindow()
      if (win) fn(win)
    }
  // Safari's other keys for the same commands; they work while hidden from the menu.
  const alternate = (item: MenuItemConstructorOptions): MenuItemConstructorOptions => ({
    ...item,
    visible: false,
    acceleratorWorksWhenHidden: true,
  })
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
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: newTab },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickProject(focusedWindow()),
        },
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: closeTab },
        { role: 'close', label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W' },
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
          (id) => focusedWindow()?.activeTab.setAgent(id),
          () => openSettings('agents'),
        ),
        { type: 'separator' },
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: withWindow((w) => w.newChat()),
        },
        { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: withWindow((w) => w.cancelChat()) },
        { type: 'separator' },
        {
          id: AUTO_MODE_ITEM,
          label: 'Auto Mode',
          type: 'checkbox',
          accelerator: 'Shift+CmdOrCtrl+A',
          click: toggleAutoMode,
        },
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Show Previous Tab',
          accelerator: 'Ctrl+Shift+Tab',
          click: withTabs((w) => w.showAdjacentTab(-1)),
        },
        {
          label: 'Show Next Tab',
          accelerator: 'Ctrl+Tab',
          click: withTabs((w) => w.showAdjacentTab(1)),
        },
        alternate({
          label: 'Show Previous Tab',
          accelerator: 'Shift+CmdOrCtrl+[',
          click: withTabs((w) => w.showAdjacentTab(-1)),
        }),
        alternate({
          label: 'Show Next Tab',
          accelerator: 'Shift+CmdOrCtrl+]',
          click: withTabs((w) => w.showAdjacentTab(1)),
        }),
        {
          label: 'Move Tab to New Window',
          click: withTabs((w) => w.moveToNewWindow(w.activeTab.id)),
        },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  syncAutoModeItem()
}

function focusExistingWindow() {
  const win = focusedWindow() ?? allWindows()[0]
  if (!win) {
    createWindow()
    return
  }
  if (win.win.isMinimized()) win.win.restore()
  // The user just launched Gui again, so coming to the front is what they asked for.
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.win.focus()
}

/** Stops agent processes that would otherwise outlive the app. */
function shutdown() {
  for (const win of allWindows()) win.destroy()
  agentHealth.dispose()
}

// One Gui per data folder: two would delete each other's live shadow-repo lock and
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
    // Pick up agents installed (or added to agents.json) while Gui was in the background.
    app.on('browser-window-focus', () => void agentHealth.onAppFocus())
    // Agent → Auto Mode shows the project the menu acts on.
    app.on('browser-window-focus', syncAutoModeItem)
    app.on('browser-window-blur', syncAutoModeItem)
    windowEvents.on('activeTab', syncAutoModeItem)
    prefsEvents.on('change', syncAutoModeItem)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    const win = createWindow()
    // Know up front whether the likely agents are ready or need sign-in; costs no usage.
    void agentHealth.checkOnLaunch(getPrefs().agentId)
    const initial = process.env.GUI_OPEN
    if (initial) openSafely(win, resolve(initial))
  })

  app.on('before-quit', shutdown)
  app.on('will-quit', shutdown)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
