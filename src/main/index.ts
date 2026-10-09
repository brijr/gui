import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { mkdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
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
import {
  Events,
  Invoke,
  MAX_TERMINAL_INPUT,
  type OutputChunk,
  Send,
  type StartForm,
} from '../shared/ipc'
import {
  SHORTCUTS,
  type ShortcutId,
  type ShortcutSpec,
  VIEWPORT_SHORTCUTS,
} from '../shared/shortcuts'
import {
  type CustomAgentEntry,
  type ImageAttachment,
  isAgentId,
  isChatForm,
  isChatGrab,
  isDrawerTab,
  isPanelEdge,
  isProjectTemplate,
  isTerminalId,
  isViewport,
  type ProjectTemplate,
  type Rect,
  type SettingsSection,
  type ShipRequest,
  type StorageKind,
  VIEWPORTS,
} from '../shared/types'
import {
  accountEvents,
  accountState,
  cancelSignIn,
  getAccount,
  mustSignIn,
  setAccountUpdates,
  signIn,
  signOut,
} from './account'
import { killStoppedAgents } from './agent'
import { agentHealth } from './agent-status'
import { agentMenuItems, openCustomAgents } from './agents'
import { offersChoice } from './chat'
import { cloneRepo, parseRepo } from './clone'
import { developerTools } from './developer-tools'
import {
  cloneGitHub,
  connectGitHub,
  createGitHub,
  disconnectGitHub,
  getGitHub,
  manageGitHub,
} from './github'
import { isLoopback } from './loopback'
import { createProject, projectName } from './new-project'
import { nodeRuntime } from './node-runtime'
import { getPrefs, prefsEvents, setPrefs } from './prefs'
import { findWorkspaceRoot } from './project'
import { loadRecent } from './recent'
import { type Recordings, registerRecordingProtocol } from './recordings'
import {
  archiveRecentChat,
  clearRecent,
  confirmAndClear,
  deleteCustom,
  getSettings,
  isSettingsContents,
  openSettings,
  removeRecent,
  saveCustom,
  setAgentEnabled,
  setChatDocked,
  setDefaultAgent,
  untrustProject,
  watchSettings,
} from './settings'
import { PREVIEW_PARTITION } from './storage'
import { getSymbols } from './symbols'
import type { ProjectTab } from './tab'
import {
  allTabs,
  allWindows,
  findTab,
  findWindow,
  focusedWindow,
  focusWindow,
  keepInBackground,
  lastFocusedWindow,
  ProjectWindow,
  windowEvents,
} from './window'

app.setName('Gui')
keepInBackground()

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
// Must run before anything reads userData, including the single-instance lock below. The
// imports above have already run by now, so no module may read userData (prefs included)
// as it's imported.
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
 * no window given, the focused one (or the one focused last) is used. A folder already open
 * opens again in another tab, so a monorepo can run two of its apps side by side.
 */
async function openProjectIn(target: ProjectWindow | undefined, root: string) {
  // Gui needs an account first: the start screen asks for it, and the folder opens after.
  if (mustSignIn()) {
    waitingForAccount.push({ target, root })
    const tab = tabToOpenIn(target)
    const win = allWindows().find((win) => win.tabs.includes(tab))
    if (win) focusWindow(win.win, { steal: true })
    return
  }
  if (!(await isDirectory(root))) {
    dialog.showErrorBox('Project not found', `${root} is not a folder.`)
    return
  }
  // A monorepo app's folder opens the monorepo with that app chosen, so installs, the
  // agent and checkpoints work from the root.
  const member = await findWorkspaceRoot(root)
  const real = member?.root ?? (await canonical(root))
  if (opening.has(real)) return
  opening.add(real)
  try {
    // The tab reads the app to run from prefs as it opens.
    if (member) setPrefs({ apps: { ...getPrefs().apps, [real]: member.appDir } })
    await tabToOpenIn(target).openProject(real)
  } finally {
    opening.delete(real)
    syncMenuItems()
  }
}

/** Folders asked for while signed out, in order. */
const waitingForAccount: { target: ProjectWindow | undefined; root: string }[] = []

/** Tells Gui's own pages, and opens what waited for an account once there is one. */
function onAccountChange() {
  const state = accountState()
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send(Events.account, state)
  if (mustSignIn()) return
  // Back from the browser: Gui comes to the front, where the user left it.
  const win = lastFocusedWindow()
  if (state.signedIn && win) focusWindow(win.win, { steal: true })
  for (const { target, root } of waitingForAccount.splice(0)) openSafely(target, root)
}

/** The window's start-screen tab, or a new tab in it; ⌘N is what makes a new window. */
function tabToOpenIn(target: ProjectWindow | undefined) {
  const live = target && allWindows().includes(target) ? target : undefined
  const win = live ?? lastFocusedWindow() ?? createWindow()
  return win.activeTab.hasProject ? win.newTab() : win.activeTab
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

/** The folder picker, for where a new or cloned project goes. Null if cancelled. */
async function pickParent(target: ProjectWindow | undefined, title: string, buttonLabel: string) {
  const parent = target?.win
  const options = {
    title,
    buttonLabel,
    properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  const folder = result.filePaths[0]
  return result.canceled || !folder ? null : folder
}

/** Asks where to put the repo, clones it there, and opens it. Cancelling the picker is fine. */
async function cloneProject(target: ProjectWindow | undefined, input: string) {
  const repo = parseRepo(input)
  if (!repo) throw new Error('Enter a GitHub repo, like owner/repo or its github.com address.')
  const folder = await pickParent(target, `Clone ${repo.name} into…`, 'Clone Here')
  if (folder) openSafely(target, await cloneRepo(repo, folder))
}

/** Asks where to put it, makes the folder there (with the template's files), and opens it. */
async function newProject(
  target: ProjectWindow | undefined,
  input: string,
  template: ProjectTemplate,
) {
  const name = projectName(input)
  if (!name) throw new Error('Use a name without slashes or colons, like my-app.')
  const folder = await pickParent(target, `Create ${name} in…`, 'Create Here')
  if (folder) openSafely(target, await createProject(name, folder, template))
}

/**
 * For folders handed to Gui from outside (the `gui` command, the Dock, Open Recent): a
 * folder already open shows its tab instead of starting a second dev server.
 */
async function openOrShow(root: string) {
  const member = await findWorkspaceRoot(root)
  const real = member?.root ?? (await canonical(root))
  const tab = allTabs().find((tab) => {
    if (tab.projectRoot !== real) return false
    const appDir = tab.getState().project?.appDir ?? null
    return !member || appDir === member.appDir
  })
  const win = tab && allWindows().find((win) => win.tabs.includes(tab))
  if (!tab || !win) return openSafely(focusedWindow(), root)
  win.showTab(tab)
  if (win.win.isMinimized()) win.win.restore()
  focusWindow(win.win, { steal: true })
}

/** Where the `gui` command lives: on PATH for zsh and bash on every Mac. */
const CLI_LINK = '/usr/local/bin/gui'
const execFileAsync = promisify(execFile)

/** Links `gui` into /usr/local/bin, asking for an administrator password if it must. */
async function installCli() {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'gui')
    : join(app.getAppPath(), 'bin', 'gui')
  try {
    try {
      await mkdir(dirname(CLI_LINK), { recursive: true })
      await rm(CLI_LINK, { force: true })
      await symlink(script, CLI_LINK)
    } catch {
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
      const command = `mkdir -p ${quote(dirname(CLI_LINK))} && ln -sf ${quote(script)} ${quote(CLI_LINK)}`
      const appleScript = `do shell script "${command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" with administrator privileges`
      await execFileAsync('/usr/bin/osascript', ['-e', appleScript])
    }
  } catch (error) {
    // Cancelling the password prompt is the user's choice, not a failure.
    if (error instanceof Error && error.message.includes('User canceled')) return
    dialog.showErrorBox(
      "Couldn't install the gui command",
      error instanceof Error ? error.message : String(error),
    )
    return
  }
  await dialog.showMessageBox({
    message: "Installed the 'gui' command",
    detail:
      'In a new terminal window, run gui in a project folder to open it here and start its dev server.',
  })
}

/** From the menu bar: the focused window, or the last one, or a new one. */
function startForm(form: StartForm) {
  ;(focusedWindow() ?? lastFocusedWindow() ?? createWindow()).showStartForm(form)
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
/** For a drawer view asking about output it can't have: nothing to draw. */
const NO_OUTPUT: OutputChunk = { id: '', data: '', end: 0 }
/** Where in a drawer view's output: a count of characters. */
const isOutputPosition = (value: unknown): value is number =>
  isNumber(value) && Number.isSafeInteger(value) && value >= 0
/** Columns or rows of a terminal: a whole number a window could hold. */
const isTerminalSize = (value: unknown): value is number =>
  isNumber(value) && Number.isInteger(value) && value >= 2 && value <= 1000
const isPoint = (value: unknown): value is { x: number; y: number } =>
  !!value &&
  typeof value === 'object' &&
  isNumber((value as Record<string, unknown>).x) &&
  isNumber((value as Record<string, unknown>).y)

const SECTIONS: readonly SettingsSection[] = [
  'agents',
  'chat',
  'projects',
  'github',
  'storage',
  'account',
]
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

const captures = new Map<
  number,
  {
    id: string
    store: Recordings
    tab: ReturnType<typeof tabFor>
    source: import('electron').WebFrameMain
    trace: ReturnType<NonNullable<ReturnType<typeof tabFor>>['traceRecording']>
    armed: boolean
    timer: NodeJS.Timeout
  }
>()

const captureOwners = new WeakSet<WebContents>()

function registerIpc() {
  ipcMain.handle(Invoke.startRecording, async (event) => {
    const win = windowFor(event)
    const tab = tabFor(event)
    if (
      win?.win.webContents !== event.sender ||
      !tab?.getState().preview.visible ||
      !tab.getState().preview.selectable ||
      !tab.recordings ||
      captures.has(event.sender.id)
    )
      throw new Error('Preview is unavailable for recording.')
    const store = tab.recordings
    const id = await store.start()
    if (tab.recordings !== store) {
      await store.discard(id)
      throw new Error('Project closed.')
    }
    const owner = event.sender.id
    const trace = tab.traceRecording()
    const timer = setTimeout(() => {
      captures.delete(owner)
      trace.dispose()
      void store.discard(id).catch(console.error)
    }, 65_000)
    captures.set(owner, { id, store, tab, source: tab.recordingSource, trace, armed: true, timer })
    if (!captureOwners.has(event.sender)) {
      captureOwners.add(event.sender)
      event.sender.once('destroyed', () => {
        const capture = captures.get(owner)
        if (!capture) return
        clearTimeout(capture.timer)
        captures.delete(owner)
        capture.trace.dispose()
        void capture.store.discard(capture.id).catch(console.error)
      })
    }
    return id
  })
  ipcMain.handle(Invoke.recordingFrame, (event, id: unknown, at: unknown, jpeg: unknown) => {
    const capture = captures.get(event.sender.id)
    if (
      !capture ||
      id !== capture.id ||
      !isNumber(at) ||
      !(jpeg instanceof Uint8Array) ||
      capture.tab?.recordings !== capture.store ||
      !capture.tab.getState().preview.selectable
    )
      return false
    return capture.store.frame(capture.id, at, jpeg)
  })
  ipcMain.handle(
    Invoke.finishRecording,
    async (event, id: unknown, duration: unknown, video: unknown, startedAt: unknown) => {
      const capture = captures.get(event.sender.id)
      if (!capture || id !== capture.id || !isNumber(duration) || !(video instanceof Uint8Array))
        throw new Error('Recording is unavailable.')
      clearTimeout(capture.timer)
      captures.delete(event.sender.id)
      try {
        // Without the recorder's start time the events can't be put on the frames' clock.
        let timeline: Awaited<ReturnType<typeof capture.trace.finish>> = []
        if (isNumber(startedAt)) timeline = await capture.trace.finish(startedAt, duration)
        else capture.trace.dispose()
        const clip = await capture.store.finish(capture.id, duration, video, timeline)
        if (capture.tab?.recordings !== capture.store) {
          await capture.store.discard(capture.id)
          return
        }
        capture.tab.attachRecording(clip)
      } catch (error) {
        await capture.store.discard(capture.id)
        throw error
      }
    },
  )
  ipcMain.handle(Invoke.discardRecording, async (event, id: unknown) => {
    if (!isString(id)) return
    const capture = captures.get(event.sender.id)
    if (capture?.id === id) {
      clearTimeout(capture.timer)
      captures.delete(event.sender.id)
      capture.trace.dispose()
      await capture.store.discard(id)
    } else {
      await tabFor(event)?.recordings?.discard(id)
    }
  })
  ipcMain.handle(Invoke.getSymbols, (event) =>
    windowFor(event) || isSettingsContents(event.sender) ? getSymbols() : {},
  )
  ipcMain.handle(Invoke.getState, (event) => windowFor(event)?.getState())
  ipcMain.handle(Invoke.getLogs, (event) => tabFor(event)?.logsOutput() ?? NO_OUTPUT)
  ipcMain.handle(Invoke.getTerminal, (event, id: unknown) => {
    // Like the terminals' other channels: the window's own chrome, for its active tab.
    const win = windowFor(event)
    if (win?.win.webContents !== event.sender || !isTerminalId(id)) return NO_OUTPUT
    return win.activeTab.terminalOutput(id)
  })
  ipcMain.handle(Invoke.getChat, (event) => tabFor(event)?.getChat())
  ipcMain.handle(Invoke.openProject, (event) => pickProject(windowFor(event)))
  const githubHandle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, value: unknown) => unknown,
  ) => {
    ipcMain.handle(channel, (event, value: unknown) => {
      if (!fromAppUi(event))
        throw new Error('GitHub connections are available only from Gui project UI.')
      return handler(event, value)
    })
  }
  githubHandle(Invoke.githubState, () => getGitHub())
  githubHandle(Invoke.githubConnect, () => reportError(() => connectGitHub()))
  githubHandle(Invoke.githubDisconnect, () => disconnectGitHub())
  githubHandle(Invoke.githubManage, () => manageGitHub())
  // The account, like GitHub, only from Gui's own UI. Failures come back as `{ error }`.
  const accountHandle = (
    channel: string,
    handler: (value: unknown) => Promise<unknown> | unknown,
  ) => {
    ipcMain.handle(channel, (event, value: unknown) => {
      if (!fromAppUi(event)) throw new Error('Gui accounts are available only from Gui’s own UI.')
      return handler(value)
    })
  }
  accountHandle(Invoke.accountState, () => accountState())
  accountHandle(Invoke.accountProfile, () => getAccount())
  accountHandle(Invoke.accountSignIn, () => reportError(() => signIn()))
  accountHandle(Invoke.accountCancel, () => reportError(() => cancelSignIn()))
  accountHandle(Invoke.accountSignOut, () => reportError(() => signOut()))
  accountHandle(Invoke.accountUpdates, (updates) =>
    reportError(async () => {
      if (typeof updates !== 'boolean') throw new Error('Invalid email preference.')
      await setAccountUpdates(updates)
    }),
  )
  githubHandle(Invoke.githubClone, async (event, value) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
      throw new Error('Choose a GitHub repository.')
    const target = windowFor(event)
    const folder = await pickParent(target, 'Clone GitHub project', 'Clone here')
    if (folder) openSafely(target, await cloneGitHub(value, folder))
  })
  githubHandle(Invoke.githubCreate, (_event, value) => {
    if (typeof value !== 'string' || !/^[\w-][\w.-]{0,99}$/.test(value))
      throw new Error('Enter a valid GitHub project name.')
    return createGitHub(value)
  })
  ipcMain.handle(Invoke.cloneProject, (event, repo: unknown) =>
    reportError(async () => {
      if (!isString(repo) || repo.length > 500) throw new Error('Enter a GitHub repo.')
      await cloneProject(windowFor(event), repo)
    }),
  )
  ipcMain.handle(Invoke.newProject, (event, name: unknown, template: unknown) =>
    reportError(async () => {
      if (!isString(name)) throw new Error('Enter a name for the project.')
      await newProject(windowFor(event), name, isProjectTemplate(template) ? template : 'blank')
    }),
  )
  ipcMain.handle(Invoke.openRecent, async (event, root: unknown) => {
    if (!isString(root)) return
    // Only paths the user opened before; anything else goes through the folder picker.
    if (!(await loadRecent()).some((project) => project.root === root)) return
    openSafely(windowFor(event), root)
  })
  ipcMain.handle(
    Invoke.send,
    (event, text: unknown, images: unknown, recordings: unknown, followUp: unknown) => {
      if (!isString(text)) return false
      if (followUp != null && (!isString(followUp) || followUp.length > 100)) return false
      const attached = images === undefined ? [] : images
      if (!Array.isArray(attached) || attached.length > MAX_IMAGES || !attached.every(isImage)) {
        return false
      }
      const ids = recordings ?? []
      if (
        !Array.isArray(ids) ||
        ids.length > 3 ||
        !ids.every(isString) ||
        new Set(ids).size !== ids.length
      )
        return false
      return tabFor(event)?.sendChatMessage(text, attached, ids, followUp ?? null) ?? false
    },
  )
  ipcMain.handle(Invoke.shipInfo, (event) => tabFor(event)?.getShipInfo() ?? null)
  ipcMain.handle(Invoke.takeScreenshot, (event, at: unknown) => {
    const tab = tabFor(event)
    return tab?.screenshotMenu(event.sender, isPoint(at) ? at : null) ?? null
  })
  ipcMain.handle(Invoke.ship, (event, request: unknown) => {
    if (!isShipRequest(request)) throw new Error('Invalid request')
    const tab = tabFor(event)
    if (!tab) throw new Error('No project is open.')
    return tab.ship(request)
  })
  ipcMain.handle(Invoke.getProposal, async (event, refresh: unknown) => {
    try {
      return (await tabFor(event)?.getProposal(refresh === true)) ?? null
    } catch {
      return null // Not a repository, or git missing: the bar just isn't shown.
    }
  })
  ipcMain.handle(Invoke.startFresh, (event) => reportError(async () => tabFor(event)?.startFresh()))
  ipcMain.handle(Invoke.bringInLatest, (event) =>
    reportError(async () => tabFor(event)?.bringInLatest()),
  )
  ipcMain.handle(Invoke.finishMerge, (event) =>
    reportError(async () => tabFor(event)?.finishMerge()),
  )
  ipcMain.handle(Invoke.cancelMerge, (event) =>
    reportError(async () => tabFor(event)?.cancelMerge()),
  )
  ipcMain.handle(Invoke.resolveConflicts, (event) =>
    reportError(async () => tabFor(event)?.resolveConflicts()),
  )
  ipcMain.handle(Invoke.restoreTurn, (event, turnId: unknown) => {
    if (isString(turnId)) return tabFor(event)?.restoreTurn(turnId)
  })
  ipcMain.handle(Invoke.redo, (event) => tabFor(event)?.redo())
  ipcMain.handle(Invoke.fixProblems, (event) => tabFor(event)?.fixProblems() ?? false)
  ipcMain.handle(Invoke.chatSignIn, (event) => tabFor(event)?.signInAgain() ?? false)
  ipcMain.handle(Invoke.chatSetUpAgent, (event) => tabFor(event)?.setUpAgent())
  ipcMain.handle(Invoke.loadCommands, (event) => tabFor(event)?.loadCommands())
  ipcMain.handle(Invoke.listChats, (event) => tabFor(event)?.listChats() ?? [])
  ipcMain.handle(Invoke.openChat, (event, id: unknown) =>
    reportError(async () => {
      if (isString(id)) await tabFor(event)?.openChat(id)
    }),
  )
  ipcMain.handle(Invoke.renameChat, (event, id: unknown, title: unknown) =>
    reportError(async () => {
      if (isString(id) && isString(title)) await tabFor(event)?.renameChat(id, title)
    }),
  )
  ipcMain.handle(Invoke.deleteChat, (event, id: unknown) =>
    reportError(async () => {
      if (isString(id)) await tabFor(event)?.deleteChat(id)
    }),
  )
  ipcMain.handle(Invoke.signIn, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.signIn(agentId)
  })
  ipcMain.handle(Invoke.installAgent, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.install(agentId)
  })
  ipcMain.handle(Invoke.connectAgent, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.connect(agentId)
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
  ipcMain.on(Send.showAgentMenu, (event, at: unknown) => {
    const point = isPoint(at) ? at : null
    tabFor(event)?.showAgentMenu(() => openSettings('agents'), event.sender, point)
  })
  ipcMain.on(Send.showChatMenu, (event, at: unknown, ship: unknown) => {
    if (!isPoint(at)) return
    const flags = ship && typeof ship === 'object' ? (ship as Record<string, unknown>) : {}
    tabFor(event)?.showChatMenu(at, { open: flags.open === true, busy: flags.busy === true })
  })
  onWindow(Send.showProjectMenu, (win) =>
    win.activeTab.showProjectMenu(
      () => void pickProject(win),
      () => win.showStartForm('newProject'),
      () => win.showStartForm('cloneRepo'),
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
  /**
   * The drawer of the window's active tab, from the window's chrome only: the chat panel
   * renders what agents write, and must not type into the user's shell. A terminal id that
   * isn't one of the active tab's terminals does nothing.
   */
  const onDrawer = (channel: string, handler: (tab: ProjectTab, ...args: unknown[]) => void) =>
    onWindow(channel, (win, ...args) => handler(win.activeTab, ...args))
  onDrawer(Send.setDrawerOpen, (tab, open) => typeof open === 'boolean' && tab.setDrawerOpen(open))
  onDrawer(Send.showLogs, (tab) => tab.showLogs())
  onDrawer(Send.selectDrawerTab, (tab, drawerTab) => {
    if (isDrawerTab(drawerTab)) tab.selectDrawerTab(drawerTab)
  })
  onDrawer(Send.newTerminal, (tab) => tab.newTerminal())
  onDrawer(Send.closeTerminal, (tab, id) => isTerminalId(id) && tab.closeTerminal(id))
  onDrawer(Send.restartTerminal, (tab, id) => isTerminalId(id) && tab.restartTerminal(id))
  onDrawer(Send.writeTerminal, (tab, id, data) => {
    if (isTerminalId(id) && isString(data) && data.length <= MAX_TERMINAL_INPUT) {
      tab.writeTerminal(id, data)
    }
  })
  onDrawer(Send.resizeTerminal, (tab, id, cols, rows) => {
    if (isTerminalId(id) && isTerminalSize(cols) && isTerminalSize(rows)) {
      tab.resizeTerminal(id, cols, rows)
    }
  })
  onDrawer(Send.clearTerminal, (tab, id) => isTerminalId(id) && tab.clearTerminal(id))
  onDrawer(Send.ackOutput, (tab, id, end) => {
    if (isString(id) && isOutputPosition(end)) tab.ackOutput(id, end)
  })

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
  ipcMain.handle(Invoke.removeRecent, (event, root: unknown) =>
    fromAppUi(event) && isString(root) ? removeRecent(root) : undefined,
  )
  ipcMain.handle(Invoke.archiveRecentChat, (event, root: unknown) =>
    reportError(async () => {
      if (fromAppUi(event) && isString(root)) await archiveRecentChat(root)
    }),
  )
  handleSettings(Invoke.clearStorage, (_event, kind) =>
    STORAGE_KINDS.includes(kind as StorageKind) ? confirmAndClear(kind as StorageKind) : false,
  )
  onAppUi(Send.openSettings, (section) =>
    openSettings(
      SECTIONS.includes(section as SettingsSection) ? (section as SettingsSection) : undefined,
    ),
  )
  onAppUi(Send.installNode, () => void nodeRuntime.install())
  onAppUi(Send.installDeveloperTools, () => developerTools.install())
  onAppUi(Send.checkAgents, (agentId) =>
    isAgentId(agentId) ? void agentHealth.check(agentId) : void agentHealth.checkAll(),
  )
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
  on(Send.setViewport, (tab, viewport) => isViewport(viewport) && tab.setViewport(viewport))
  on(Send.zoomPreview, (tab, step) => {
    if (step === 1 || step === -1 || step === 0) tab.zoom(step)
  })
  on(Send.toggleSelect, (tab) => void tab.toggleSelect())
  on(Send.stopSelecting, (tab) => void tab.setSelecting(false))
  on(Send.pickHover, (tab, at) => (at === null || isPoint(at)) && tab.pickHover(at))
  on(Send.pickElement, (tab, at, add) => isPoint(at) && tab.pickElement(at, add === true))
  on(Send.pickArea, (tab, rect, add) => isRect(rect) && tab.pickArea(rect, add === true))
  on(Send.pickWheel, (tab, at, dx, dy) => {
    if (isPoint(at) && isNumber(dx) && isNumber(dy)) tab.pickWheel(at, dx, dy)
  })
  onWindow(Send.setCanvasRect, (win, rect) => isRect(rect) && win.setCanvasRect(rect))
  onWindow(Send.morphShown, (win, id, canvas) => {
    if (isNumber(id) && isRect(canvas)) win.morphShown(id, canvas)
  })
  onWindow(Send.morphLanded, (win, id, seq) => {
    if (isNumber(id) && isNumber(seq)) win.activeTab.morphLanded(id, seq)
  })
  onWindow(Send.cancelMorph, (win, id) => isNumber(id) && win.activeTab.cancelMorph(id))
  onWindow(Send.setFocusMode, (win, on) => typeof on === 'boolean' && win.setFocusMode(on))
  onWindow(Send.setShortcutsOpen, (win, open) => {
    if (typeof open === 'boolean') win.setShortcutsOpen(open)
  })
  on(Send.toggleChat, (tab) => tab.toggleChat())
  on(Send.resizeLogs, (tab, cols, rows) => {
    if (isNumber(cols) && isNumber(rows)) tab.resizeLogs(Math.floor(cols), Math.floor(rows))
  })
  on(Send.cancel, (tab) => tab.cancelChat())
  on(Send.removeQueued, (tab, id) => isString(id) && tab.removeQueued(id))
  on(Send.sendQueuedNow, (tab) => tab.sendQueuedNow())
  on(Send.setAutoApprove, (tab, on) => typeof on === 'boolean' && tab.setAutoApprove(on))
  on(Send.setShipSheetOpen, (tab, open) => typeof open === 'boolean' && tab.setShipSheetOpen(open))
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
  on(Send.removeSelection, (tab, id) => isString(id) && tab.removeSelection(id))
  on(Send.hoverSelection, (tab, id) => (id === null || isString(id)) && tab.hoverSelection(id))
  on(Send.setMinimized, (tab, minimized) => tab.setMinimized(minimized === true))
  on(Send.expandChat, (tab) => tab.expandChat())
  on(Send.togglePopOut, (tab) => tab.togglePopOut())
  on(Send.toggleDock, (tab) => tab.toggleDock())
  on(Send.grabChat, (tab, at) => isChatGrab(at) && tab.grabChat(at))
  on(Send.dragChat, (tab, dx, dy) => isNumber(dx) && isNumber(dy) && tab.dragChat(dx, dy))
  on(Send.endDragChat, (tab, velocity) => tab.endDragChat(isPoint(velocity) ? velocity : undefined))
  on(Send.chatMorphed, (tab, form, seq) => {
    if (isChatForm(form) && isNumber(seq)) tab.chatMorphed(form, seq)
  })
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
  // Only an explicitly started preview recording may request display media from Gui's UI.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const armed = !!wc && captures.get(wc.id)?.armed === true
    callback(
      armed &&
        (permission === 'display-capture' ||
          (permission === 'media' &&
            'mediaTypes' in details &&
            (details.mediaTypes?.length ?? 0) === 0)),
    )
  })
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) =>
      !!wc &&
      captures.get(wc.id)?.armed === true &&
      (permission === 'media' || permission === 'display-capture'),
  )
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const wc = request.frame && webContents.fromFrame(request.frame)
    const capture = wc && captures.get(wc.id)
    if (
      !capture?.armed ||
      !request.videoRequested ||
      request.audioRequested ||
      capture.source.detached ||
      capture.tab?.recordings !== capture.store
    ) {
      callback({})
      return
    }
    capture.armed = false
    callback({ video: capture.source })
  })
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
const MOVE_TAB_ITEM = 'move-tab'
const ALLOW_ITEM = 'allow'
const DONT_ALLOW_ITEM = 'dont-allow'
const FOCUS_MODE_ITEM = 'focus-mode'

type SyncedItem = Pick<MenuItemConstructorOptions, 'checked' | 'enabled'>

/**
 * Menu items that follow the window menus act on: View → Focus Mode is checked while the
 * window's in it; Agent → Auto Mode is checked when the project it would change is in Auto
 * mode; Allow and Don't Allow answer a permission card
 * that's waiting (see `permissionAnswer`); Window → Move Tab to New Window needs a second tab.
 *
 * Their keys reach a page first: ⌘⌫ deletes typing in a text field, and the chat panel
 * answers ⌘↩ and ⌘⌫ itself (chat-panel.tsx), so only keys nothing else took get here.
 */
function syncedItemStates(): Record<string, SyncedItem> {
  const tab = menuTab()
  return {
    [FOCUS_MODE_ITEM]: { checked: menuWindow()?.focusMode ?? false },
    [AUTO_MODE_ITEM]: { checked: tab?.autoApprove ?? false },
    [ALLOW_ITEM]: { enabled: !!tab?.permissionAnswer(true) },
    [DONT_ALLOW_ITEM]: { enabled: !!tab?.permissionAnswer(false) },
    [MOVE_TAB_ITEM]: { enabled: (menuWindow()?.tabs.length ?? 0) > 1 },
  }
}

function syncMenuItems() {
  const menu = Menu.getApplicationMenu()
  for (const [id, { checked, enabled }] of Object.entries(syncedItemStates())) {
    const item = menu?.getMenuItemById(id)
    if (!item) continue
    if (checked !== undefined && item.checked !== checked) item.checked = checked
    if (enabled !== undefined && item.enabled !== enabled) item.enabled = enabled
  }
}

/** Only from the user's own menu choice or keystroke: agents never get to turn this on. */
function toggleAutoMode() {
  const tab = menuTab()
  tab?.setAutoApprove(!tab.autoApprove)
  // The click already flipped the checkmark; it follows the project's setting instead.
  syncMenuItems()
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
  // A popped-out chat's window: ⌘W puts the chat back, rather than closing its tab.
  const focusedWin = BrowserWindow.getFocusedWindow()
  const popped = focusedWin && allTabs().find((tab) => tab.popoutWindow === focusedWin)
  if (popped) return popped.togglePopOut()
  const win = menuWindow()
  if (!win) BrowserWindow.getFocusedWindow()?.close()
  else if (!win.win.isMinimized()) win.closeTab(win.activeTab.id)
}

/** The Agent menu's agents: none checked, since the menu acts on whichever tab is active. */
function agentItems() {
  return agentMenuItems(
    agentHealth.list(),
    agentHealth.customError,
    null,
    (id) => focusedWindow()?.activeTab.setAgent(id),
    () => openSettings('agents'),
  )
}

/** All the items show and which agent each picks: JSON drops only their click handlers. */
const shownAgents = (items: MenuItemConstructorOptions[]) => JSON.stringify(items)

/** `shownAgents` of the agents the current menu was built with */
let builtAgents = ''
let agentsQueued = false

/**
 * Agent health changes at every step of every check, about ten times at launch, but most
 * steps (Checking, then Ready) change neither which agents the menu lists nor what it says
 * of them; only a change it shows rebuilds it. Changes that come together rebuild it once,
 * before the event loop moves on.
 */
function onAgentHealth() {
  if (agentsQueued) return
  agentsQueued = true
  queueMicrotask(() => {
    agentsQueued = false
    if (shownAgents(agentItems()) !== builtAgents) buildMenu()
  })
}

function buildMenu() {
  // Built as `syncMenuItems` would leave them: agent checks rebuild the menu at any moment,
  // and a new menu's defaults (enabled, unchecked) mustn't show, even for an instant.
  const synced = syncedItemStates()
  const agents = agentItems()
  builtAgents = shownAgents(agents)
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
  /**
   * A shortcut's item, its label and keys from the registry (src/shared/shortcuts.ts), with
   * its other keys after it: hidden from the menu, they work all the same (Safari's ⇧⌘] for
   * the next tab).
   */
  const item = (
    id: ShortcutId,
    options: MenuItemConstructorOptions = {},
  ): MenuItemConstructorOptions[] => {
    const { label, accelerator, alternates = [] }: ShortcutSpec = SHORTCUTS[id]
    const visible = { label, accelerator, ...options }
    const hidden = alternates.map(
      (keys): MenuItemConstructorOptions => ({
        ...visible,
        id: undefined,
        accelerator: keys,
        visible: false,
        acceleratorWorksWhenHidden: true,
      }),
    )
    return [visible, ...hidden]
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...item('settings', { click: () => openSettings() }),
        { label: "Install 'gui' Command…", click: () => void installCli() },
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
        ...item('newTab', { click: newTab }),
        ...item('newWindow', { click: () => createWindow() }),
        ...item('openProject', { click: () => void pickProject(focusedWindow()) }),
        ...item('newProject', { click: () => startForm('newProject') }),
        ...item('cloneRepo', {
          click: () => startForm('cloneRepo'),
        }),
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        ...item('closeTab', { click: closeTab }),
        ...item('closeWindow', { role: 'close' }),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        ...item('undo', { click: () => void editHistory('undo') }),
        ...item('redo', { click: () => void editHistory('redo') }),
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
        ...item('selectElement', { click: withWindow((w) => void w.toggleSelect()) }),
        // ⌘B shows or hides the chat, like a sidebar; ⌘L puts the cursor in it (Cursor's ⌘L).
        ...item('toggleChat', { click: withWindow((w) => w.toggleChat()) }),
        ...item('focusMessageBox', { click: withWindow((w) => w.focusMessageBox()) }),
        ...item('dockChat', { click: withWindow((w) => w.toggleDock()) }),
        ...item('popOutChat', { click: withWindow((w) => w.togglePopOut()) }),
        // The drawer under the canvas, as VS Code's ⌘J toggles its panel.
        ...item('toggleTerminal', { click: withWindow((w) => w.toggleDrawer()) }),
        { type: 'separator' },
        ...item('focusAddress', { click: withTabs((w) => w.focusAddress()) }),
        ...item('reload', { click: withWindow((w) => w.reload()) }),
        ...item('hardReload', { click: withWindow((w) => w.hardReload()) }),
        ...item('back', { click: withWindow((w) => w.back()) }),
        ...item('forward', { click: withWindow((w) => w.forward()) }),
        { type: 'separator' },
        ...VIEWPORTS.flatMap(({ id }) =>
          item(VIEWPORT_SHORTCUTS[id], { click: withWindow((w) => w.setViewport(id)) }),
        ),
        { type: 'separator' },
        ...item('zoomIn', { click: withWindow((w) => w.zoom(1)) }),
        ...item('zoomOut', { click: withWindow((w) => w.zoom(-1)) }),
        ...item('actualSize', { click: withWindow((w) => w.zoom(0)) }),
        { type: 'separator' },
        ...item('screenshot', { click: withTabs((w) => w.screenshot()) }),
        ...item('recordPreview', { click: withTabs((w) => w.recordPreview()) }),
        ...item('focusMode', {
          id: FOCUS_MODE_ITEM,
          type: 'checkbox',
          ...synced[FOCUS_MODE_ITEM],
          click: () => {
            const win = menuWindow()
            win?.setFocusMode(!win.focusMode)
            // The click flipped the checkmark; it follows the window instead.
            syncMenuItems()
          },
        }),
        { type: 'separator' },
        ...item('previewDevTools', { click: withWindow((w) => w.toggleDevTools()) }),
        ...item('appDevTools', { role: 'toggleDevTools' }),
      ],
    },
    {
      label: 'Agent',
      submenu: [
        ...agents,
        { type: 'separator' },
        ...item('chooseModel', { click: withWindow((w) => w.chooseModel()) }),
        ...item('newChat', { click: withWindow((w) => w.newChat()) }),
        ...item('stop', { click: withWindow((w) => w.cancelChat()) }),
        { type: 'separator' },
        ...item('allow', {
          id: ALLOW_ITEM,
          ...synced[ALLOW_ITEM],
          click: withWindow((w) => w.answerPermission(true)),
        }),
        ...item('dontAllow', {
          id: DONT_ALLOW_ITEM,
          ...synced[DONT_ALLOW_ITEM],
          click: withWindow((w) => w.answerPermission(false)),
        }),
        { type: 'separator' },
        ...item('autoMode', {
          id: AUTO_MODE_ITEM,
          type: 'checkbox',
          ...synced[AUTO_MODE_ITEM],
          click: toggleAutoMode,
        }),
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        ...item('previousTab', { click: withTabs((w) => w.showAdjacentTab(-1)) }),
        ...item('nextTab', { click: withTabs((w) => w.showAdjacentTab(1)) }),
        {
          id: MOVE_TAB_ITEM,
          label: 'Move Tab to New Window',
          ...synced[MOVE_TAB_ITEM],
          click: withTabs((w) => w.moveToNewWindow(w.activeTab.id)),
        },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      // macOS puts its search field at the top.
      label: 'Help',
      role: 'help',
      submenu: [
        ...item('keyboardShortcuts', {
          click: withTabs((w) => w.setShortcutsOpen(!w.shortcutsOpen)),
        }),
      ],
    },
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
  // The user just launched Gui again, so coming to the front is what they asked for.
  focusWindow(win.win, { steal: true })
}

/** Stops agent processes that would otherwise outlive the app. */
function shutdown() {
  for (const win of allWindows()) win.destroy()
  agentHealth.dispose()
  nodeRuntime.dispose()
  killStoppedAgents()
}

// A rejected promise nothing awaited is logged rather than lost.
process.on('unhandledRejection', (reason) => console.error('[gui] unhandled rejection', reason))

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
    void app.whenReady().then(() => openOrShow(path))
  })

  app.whenReady().then(() => {
    lockDownSessions()
    registerRecordingProtocol()
    registerIpc()
    accountEvents.on('change', onAccountChange)
    watchSettings()
    buildMenu()
    // The Agent menu lists what's installed and signed in.
    agentHealth.on('change', onAgentHealth)
    // Pick up agents installed (or added to agents.json) while Gui was in the background.
    app.on('browser-window-focus', () => void agentHealth.onAppFocus())
    app.on('browser-window-focus', () => void developerTools.recheck())
    // Auto Mode and Move Tab follow the window and project the menu acts on.
    app.on('browser-window-focus', syncMenuItems)
    app.on('browser-window-blur', syncMenuItems)
    windowEvents.on('activeTab', syncMenuItems)
    windowEvents.on('tabs', syncMenuItems)
    windowEvents.on('changed', syncMenuItems)
    prefsEvents.on('change', syncMenuItems)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
    const win = createWindow()
    // A session the service no longer knows (signed out elsewhere, deleted) asks for sign-in
    // again. Offline, Gui stays signed in.
    if (accountState().signedIn) void getAccount().catch(() => undefined)
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
