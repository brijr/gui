import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
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
} from 'electron'
import { Invoke, Send } from '../shared/ipc'
import { AGENTS, type AgentId, type Rect, type Viewport } from '../shared/types'
import { loadRecent } from './recent'
import { allWindows, findWindow, focusedWindow, ProjectWindow } from './window'

app.setName('Grat')

const VIEWPORTS: readonly Viewport[] = ['desktop', 'tablet', 'mobile']

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Opens in the given window if it's empty, otherwise in a new window. */
async function openProjectIn(target: ProjectWindow | undefined, root: string) {
  if (!(await isDirectory(root))) {
    dialog.showErrorBox('Project not found', `${root} is not a folder.`)
    return
  }
  const existing = allWindows().find((w) => w.getState().project?.root === root)
  if (existing) {
    existing.win.focus()
    return
  }
  const win = target && !target.hasProject ? target : createWindow()
  await win.openProject(root)
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
  if (!result.canceled && root) await openProjectIn(target, root)
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

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => isNumber(rect[key]))
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
    return openProjectIn(windowFor(event), root)
  })
  ipcMain.handle(Invoke.send, (event, text: unknown) => {
    if (isString(text)) return windowFor(event)?.sendChatMessage(text)
  })
  ipcMain.handle(Invoke.restoreTurn, (event, turnId: unknown) => {
    if (isString(turnId)) return windowFor(event)?.restoreTurn(turnId)
  })
  ipcMain.handle(Invoke.redo, (event) => windowFor(event)?.redo())

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
  on(Send.showAgentMenu, (win) => win.showAgentMenu())
  on(Send.showProjectMenu, (win) =>
    win.showProjectMenu(
      () => void pickProject(win),
      (root) => void openProjectIn(win, root),
    ),
  )
  on(Send.setAgent, (win, agentId) => {
    const agent = AGENTS.find((a) => a.id === agentId)
    if (agent) win.setAgent(agent.id)
  })
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
  on(Send.dragChat, (win, dx, dy) => isNumber(dx) && isNumber(dy) && win.dragChat(dx, dy))
  on(Send.endDragChat, (win) => win.endDragChat())
}

/** Permissions the previewed app may use, and only from a local origin. */
const PREVIEW_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])

function isLocalOrigin(url: string | undefined) {
  if (!url) return false
  try {
    const { hostname } = new URL(url)
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost')
  } catch {
    return false
  }
}

/**
 * Electron grants every permission unless a handler says otherwise. The preview runs
 * the user's app plus whatever third-party scripts it loads, so deny by default.
 */
function lockDownSessions() {
  const preview = session.fromPartition('persist:grat-preview')
  preview.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(PREVIEW_PERMISSIONS.has(permission) && isLocalOrigin(details.requestingUrl))
  })
  preview.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return PREVIEW_PERMISSIONS.has(permission) && isLocalOrigin(requestingOrigin)
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

function buildMenu() {
  const withWindow =
    (fn: (win: ProjectWindow) => void): MenuItemConstructorOptions['click'] =>
    () => {
      const win = focusedWindow()
      if (win) fn(win)
    }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
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
    { role: 'editMenu' },
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
        ...AGENTS.map(
          (agent): MenuItemConstructorOptions => ({
            label: agent.name,
            click: withWindow((w) => w.setAgent(agent.id as AgentId)),
          }),
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

app.on('open-file', (event, path) => {
  event.preventDefault()
  void app.whenReady().then(() => openProjectIn(focusedWindow(), path))
})

app.whenReady().then(async () => {
  lockDownSessions()
  registerIpc()
  buildMenu()
  const initial = process.env.GRAT_OPEN
  const win = createWindow()
  if (initial) await openProjectIn(win, resolve(initial))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const win of allWindows()) win.destroy()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
