import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, stat, symlink } from 'node:fs/promises'
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
  shell,
  systemPreferences,
  type WebContents,
  webContents,
} from 'electron'
import {
  MAX_IMAGE_BASE64,
  MAX_IMAGES,
  MAX_NARRATED_RECORDING_MS,
  MAX_RECORDING_MS,
  MAX_THUMBNAIL,
} from '../shared/bounded'
import { type FindAction, MAX_FIND_TEXT } from '../shared/find'
import {
  Events,
  GUIDE_POINTER_PHASES,
  type GuidePointerPhase,
  Invoke,
  MAX_TERMINAL_INPUT,
  type OutputChunk,
  Send,
  type StartForm,
} from '../shared/ipc'
import {
  type AllRequestArgs,
  IpcRequestError,
  type LegacyChannel,
  type LegacyResult,
} from '../shared/ipc-requests'
import { PreviewGuides } from '../shared/preview-guides'
import { MAX_PREVIEW_TEXT, PreviewText } from '../shared/preview-text'
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
  isCustomViewport,
  isDrawerTab,
  isPanelEdge,
  isProjectTemplate,
  isTerminalId,
  isViewport,
  type ProjectTemplate,
  type Rect,
  type SettingsSection,
  type StartCommandInput,
  type StorageKind,
  VARIATION_ACTIONS,
  type VariationAction,
  VIEWPORTS,
} from '../shared/types'
import { accountEvents, accountState, getAccount, mustSignIn } from './account'
import { registerAccountIpc } from './account-ipc'
import { killStoppedAgents } from './agent'
import { agentHealth } from './agent-status'
import { agentMenuItems, openCustomAgents } from './agents'
import {
  boardIdOf,
  boardRoot,
  createBoard,
  deleteBoard,
  isBoardId,
  listBoards,
  registerThumbProtocol,
} from './board'
import { registerBoardIpc } from './board-ipc'
import { offersChoice } from './chat'
import { cloneRepo, parseRepo } from './clone'
import { errorReport, sendCrashReport } from './crash-reports'
import { developerTools } from './developer-tools'
import { cloneGitHub } from './github'
import { flushHistorySync } from './history'
import {
  createLegacyRegistrar,
  createRequestRegistrar,
  createWindowMessageRegistrar,
  noRequestArgs,
  stringRequestArgs,
} from './ipc-handler'
import { isLoopback } from './loopback'
import { preloadMcpSdk } from './mcp-server'
import { chatWillHide, terminalWillHide } from './menu-toggles'
import { createProject, createProjectFromFrame, projectName } from './new-project'
import { nodeRuntime } from './node-runtime'
import { flushPrefsSync, getPrefs, prefsEvents, setPrefs } from './prefs'
import { execFile } from './process'
import { finishEndingSync } from './process-groups'
import { findWorkspaceRoot } from './project'
import { loadRecent } from './recent'
import { type Recordings, registerRecordingProtocol } from './recordings'
import { isAppContents } from './renderer'
import {
  archiveRecentChat,
  clearRecent,
  confirmAndClear,
  deleteCustom,
  getSettings,
  isSettingsContents,
  openSettings,
  removeRecent,
  resetStartCommand,
  saveCustom,
  setAgentEnabled,
  setChatDocked,
  setChatSidebarSide,
  setCrashReports,
  setDefaultAgent,
  untrustProject,
  watchSettings,
} from './settings'
import { getShellEnv } from './shell-env'
import { PREVIEW_PARTITION } from './storage'
import { getSymbols } from './symbols'
import type { ProjectTab } from './tab'
import { showToolbarMenu, toolbarMenuItems } from './toolbar-menu'
import { prepareTranscription } from './transcribe'
import { checkForUpdatesByHand, startUpdates } from './updates'
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
  shareBoards,
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

/** Projects on their way into a tab, by real path, so a double-click can't open one twice. */
const opening = new Map<string, ProjectTab>()

/**
 * Whether `real` is on its way into a tab that still wants it. An opening whose tab was
 * closed meanwhile takes a moment to wind down, and must not swallow the next request for
 * the same project.
 */
const isOpening = (real: string) => opening.get(real)?.projectRoot === real

const canonical = (path: string) => realpath(path).catch(() => path)

/**
 * Opens in the window's active tab if it's a start screen, otherwise in a new tab there. With
 * no window given, the focused one (or the one focused last) is used. A folder already open
 * opens again in another tab, so a monorepo can run two of its apps side by side.
 */
async function openProjectIn(target: ProjectWindow | undefined, root: string, into?: ProjectTab) {
  // Gui needs an account first: the start screen asks for it, and the folder opens after.
  if (mustSignIn()) {
    waitingForAccount.push({ target, root })
    const tab = tabToOpenIn(target, into)
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
  if (isOpening(real)) return
  const tab = tabToOpenIn(target, into)
  opening.set(real, tab)
  try {
    // The tab reads the app to run from prefs as it opens.
    if (member) setPrefs({ apps: { ...getPrefs().apps, [real]: member.appDir } })
    await tab.openProject(real)
  } finally {
    if (opening.get(real) === tab) opening.delete(real)
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

/**
 * The window's start-screen tab, or a new tab in it; ⌘N is what makes a new window. `into`, a
 * start-screen tab made for this opening (Reopen Closed Tab's), while it's still in a window.
 */
function tabToOpenIn(target: ProjectWindow | undefined, into?: ProjectTab) {
  if (into && !into.hasProject && allTabs().includes(into)) return into
  const live = target && allWindows().includes(target) ? target : undefined
  const win = live ?? lastFocusedWindow() ?? createWindow()
  return win.activeTab.hasProject ? win.newTab() : win.activeTab
}

/** For user-initiated opens: surface failures instead of dropping them. */
function openSafely(target: ProjectWindow | undefined, root: string, into?: ProjectTab) {
  openProjectIn(target, root, into).catch((error: unknown) => {
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
  if (!repo)
    throw new Error('Enter a GitHub repository, like owner/repo or its github.com address.')
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
 * A canvas in the window's start-screen tab, or a new tab there. One already open in a tab
 * shows that tab instead: two tabs on one canvas would each keep their own layout.
 */
async function openBoardIn(target: ProjectWindow | undefined, id: string, into?: ProjectTab) {
  if (!isBoardId(id) || mustSignIn()) return
  const root = boardRoot(id)
  const open = allTabs().find((tab) => tab.projectRoot === root)
  const shown = open && allWindows().find((win) => win.tabs.includes(open))
  if (open && shown) {
    shown.showTab(open)
    focusWindow(shown.win, { steal: true })
    return
  }
  if (!(await isDirectory(root))) {
    shareBoards(await listBoards())
    return
  }
  if (isOpening(root)) return
  const tab = tabToOpenIn(target, into)
  opening.set(root, tab)
  try {
    await tab.openBoard(root)
  } catch (error) {
    dialog.showErrorBox(
      "Couldn't open the canvas",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    if (opening.get(root) === tab) opening.delete(root)
    syncMenuItems()
  }
}

/** ⌥⌘N, or the start screen's button: a new canvas, open at once, without a dialog. */
async function newBoard(target: ProjectWindow | undefined) {
  if (mustSignIn()) return
  try {
    const root = await createBoard()
    const id = boardIdOf(root)
    if (id) await openBoardIn(target, id)
  } catch (error) {
    dialog.showErrorBox(
      "Couldn't make a canvas",
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** Turn into Project: the frame's page as a new project's app, made where the user picks. */
async function promoteFrame(win: ProjectWindow, tab: ProjectTab, id: string) {
  const board = tab.boardSession
  const frame = board?.frame(id)
  if (!board || !frame) return
  const slug = frame.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const name = projectName(slug) ?? 'canvas-frame'
  try {
    const folder = await pickParent(win, `Create ${name} in…`, 'Create Here')
    if (!folder) return
    const html = await readFile(board.framePath(id), 'utf8')
    openSafely(win, await createProjectFromFrame(name, folder, html, join(board.root, 'assets')))
  } catch (error) {
    dialog.showErrorBox(
      "Couldn't make the project",
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** The start screen's menu for a canvas: open it, show it in the Finder, or delete it. */
function showRecentBoardMenu(win: ProjectWindow, id: string) {
  if (!isBoardId(id)) return
  const root = boardRoot(id)
  Menu.buildFromTemplate([
    { label: 'Open', click: () => void openBoardIn(win, id) },
    { label: 'Reveal in Finder', click: () => shell.showItemInFolder(join(root, 'canvas.json')) },
    { type: 'separator' },
    {
      label: 'Delete Canvas…',
      click: async () => {
        if (allTabs().some((tab) => tab.projectRoot === root)) {
          await dialog.showMessageBox(win.win, {
            message: 'Close the canvas first',
            detail: 'It’s open in a tab. Close that tab, then delete it.',
          })
          return
        }
        const boards = await listBoards()
        const name = boards.find((board) => board.id === id)?.name ?? 'this canvas'
        const { response } = await dialog.showMessageBox(win.win, {
          type: 'warning',
          message: `Delete ${name}?`,
          detail: 'Its frames and their pages are deleted for good.',
          buttons: ['Delete', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
        })
        if (response !== 0) return
        await deleteBoard(id)
        shareBoards(await listBoards())
      },
    },
  ]).popup({ window: win.win })
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

/** The `gui` script inside this copy of Gui. */
const cliScript = () =>
  app.isPackaged ? join(process.resourcesPath, 'bin', 'gui') : join(app.getAppPath(), 'bin', 'gui')

/**
 * Runs `gui skill setup` or `gui skill remove`, which install or remove the skill that
 * teaches coding agents to open projects in Gui (bin/gui), and returns what it says it did.
 * The script only touches a copy carrying Gui's marker, so the user's own skill stays.
 */
function runSkillCommand(action: 'setup' | 'remove') {
  return new Promise<string>((resolve, reject) => {
    execFile(
      '/bin/sh',
      [cliScript(), 'skill', action],
      { env: { ...process.env, HOME: app.getPath('home') } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).trim() || error.message))
        else resolve(String(stdout).trim())
      },
    )
  })
}

/**
 * Links `gui` into /usr/local/bin, asking for an administrator password if it must, then
 * installs the open-in-gui agent skill so coding agents know the command is there.
 */
async function installCli() {
  const script = cliScript()
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
  const skill = await runSkillCommand('setup').catch(
    (error: unknown) =>
      `Couldn't install the agent skill: ${error instanceof Error ? error.message : String(error)}`,
  )
  await dialog.showMessageBox({
    message: "Installed the 'gui' command",
    detail: [
      'In a new terminal window, run gui in a project folder to open it here and start its dev server.',
      skill,
    ].join('\n\n'),
  })
}

/** Removes the open-in-gui agent skill, if Gui installed it. */
async function removeAgentSkill() {
  try {
    const detail = await runSkillCommand('remove')
    await dialog.showMessageBox({ message: 'The open-in-gui agent skill', detail })
  } catch (error) {
    dialog.showErrorBox(
      "Couldn't remove the agent skill",
      error instanceof Error ? error.message : String(error),
    )
  }
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
const isStartCommandInput = (value: unknown): value is StartCommandInput => {
  if (!value || typeof value !== 'object') return false
  const { command, dir, url } = value as Record<string, unknown>
  const optional = (field: unknown) => field === undefined || field === null || isString(field)
  return isString(command) && optional(dir) && optional(url)
}
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
const isRulerPhase = (value: unknown): value is 'move' | 'end' | 'cancel' =>
  value === 'move' || value === 'end' || value === 'cancel'
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

const captures = new Map<
  number,
  {
    id: string
    store: Recordings
    tab: ReturnType<typeof tabFor>
    source: import('electron').WebFrameMain
    trace: ReturnType<NonNullable<ReturnType<typeof tabFor>>['traceRecording']>
    armed: boolean
    /** A narrated clip may open the microphone, once */
    mic: boolean
    narrated: boolean
    timer: NodeJS.Timeout
  }
>()

const captureOwners = new WeakSet<WebContents>()

function registerIpc() {
  const handleLegacy = createLegacyRegistrar<IpcMainInvokeEvent>((channel, listener) =>
    ipcMain.handle(channel, listener),
  )
  const requireTab = (event: IpcMainInvokeEvent) => {
    const tab = tabFor(event)
    if (!tab) throw new IpcRequestError('no_tab', 'Project closed.')
    return tab
  }

  handleLegacy(Invoke.startRecording, async (event, narrate: unknown) => {
    const win = windowFor(event)
    const tab = tabFor(event)
    if (
      win?.win.webContents !== event.sender ||
      !tab?.getState().preview.visible ||
      !tab.getState().preview.selectable ||
      tab.getState().preview.website !== null ||
      !tab.recordings ||
      captures.has(event.sender.id)
    )
      throw new Error('Preview is unavailable for recording.')
    const store = tab.recordings
    // macOS asks once; after a no, only System Settings can turn it on.
    let notice: string | null = null
    let narrated = narrate === true
    if (narrated && process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      const granted =
        status === 'granted' ||
        (status === 'not-determined' && (await systemPreferences.askForMediaAccess('microphone')))
      if (!granted) {
        narrated = false
        notice =
          'Gui can’t use the microphone. Turn it on in System Settings → Privacy & Security → Microphone.'
      }
    }
    // The speech model downloads while they talk, not after they stop.
    if (narrated) prepareTranscription()
    const id = await store.start(narrated)
    if (tab.recordings !== store || captures.has(event.sender.id)) {
      await store.discard(id)
      throw new Error('Project closed.')
    }
    const owner = event.sender.id
    const sender = event.sender
    const trace = tab.traceRecording((frame) => {
      if (!sender.isDestroyed() && captures.get(owner)?.id === id)
        sender.send(Events.recordingCursor, { id, ...frame })
    })
    const timer = setTimeout(
      () => {
        captures.delete(owner)
        trace.dispose()
        void store.discard(id).catch(console.error)
      },
      (narrated ? MAX_NARRATED_RECORDING_MS : MAX_RECORDING_MS) + 5000,
    )
    captures.set(owner, {
      id,
      store,
      tab,
      source: tab.recordingSource,
      trace,
      armed: true,
      mic: narrated,
      narrated,
      timer,
    })
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
    return { id, narrated, notice }
  })
  handleLegacy(Invoke.recordingFrame, (event, id: unknown, at: unknown, jpeg: unknown) => {
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
  handleLegacy(Invoke.recordingVideo, (event, id: unknown, chunk: unknown) => {
    const capture = captures.get(event.sender.id)
    if (
      !capture ||
      id !== capture.id ||
      !(chunk instanceof Uint8Array) ||
      capture.tab?.recordings !== capture.store
    )
      return false
    return capture.store.video(capture.id, chunk)
  })
  handleLegacy(Invoke.prepareNarration, () => {
    prepareTranscription()
  })
  handleLegacy(
    Invoke.finishRecording,
    async (event, id: unknown, duration: unknown, startedAt: unknown, audio: unknown) => {
      const capture = captures.get(event.sender.id)
      if (
        !capture ||
        id !== capture.id ||
        !isNumber(duration) ||
        (audio !== undefined && audio !== null && !(audio instanceof Uint8Array))
      )
        throw new Error('Recording is unavailable.')
      clearTimeout(capture.timer)
      captures.delete(event.sender.id)
      try {
        // Without the recorder's start time the events can't be put on the frames' clock.
        let traced: Awaited<ReturnType<typeof capture.trace.finish>> | null = null
        if (isNumber(startedAt)) traced = await capture.trace.finish(startedAt, duration)
        else capture.trace.dispose()
        const clip = await capture.store.finish(capture.id, duration, {
          timeline: traced?.timeline ?? [],
          cursor: traced?.cursor ?? null,
          audio: capture.narrated && audio instanceof Uint8Array ? audio : null,
        })
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
  handleLegacy(Invoke.discardRecording, async (event, id: unknown) => {
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
  handleLegacy(Invoke.getSymbols, (event) =>
    windowFor(event) || isSettingsContents(event.sender) ? getSymbols() : {},
  )
  handleLegacy(Invoke.getState, (event) => {
    const win = windowFor(event)
    if (!win) throw new IpcRequestError('forbidden', 'Window unavailable.')
    return win.getState()
  })
  handleLegacy(Invoke.getLogs, (event) => tabFor(event)?.logsOutput() ?? NO_OUTPUT)
  handleLegacy(Invoke.boardChatCover, (event) => tabFor(event)?.chatCover() ?? null)
  handleLegacy(Invoke.getRulers, (event) => {
    // The window's own chrome draws the rulers, for the tab it shows.
    const win = windowFor(event)
    return win?.win.webContents === event.sender ? win.activeTab.rulers() : null
  })
  handleLegacy(Invoke.getTerminal, (event, id: unknown) => {
    // Like the terminals' other channels: the window's own chrome, for its active tab.
    const win = windowFor(event)
    if (win?.win.webContents !== event.sender)
      throw new IpcRequestError(
        'forbidden',
        'Terminal output is available only from Gui’s project window.',
      )
    if (!isTerminalId(id)) throw new IpcRequestError('invalid_request', 'Invalid terminal.')
    return win.activeTab.terminalOutput(id)
  })
  handleLegacy(Invoke.getChat, (event) => requireTab(event).getChat())
  handleLegacy(Invoke.openProject, (event) => pickProject(windowFor(event)))
  const handleRequest = createRequestRegistrar<IpcMainInvokeEvent>((channel, listener) =>
    ipcMain.handle(channel, listener),
  )
  registerAccountIpc(handleRequest, {
    authorize: fromAppUi,
    clone: async (event, id) => {
      const target = windowFor(event)
      const folder = await pickParent(target, 'Clone GitHub repository', 'Clone Here')
      if (folder) openSafely(target, await cloneGitHub(id, folder))
    },
  })
  handleLegacy(Invoke.cloneProject, (event, repo: unknown) =>
    reportError(async () => {
      if (!isString(repo) || repo.length > 500) throw new Error('Enter a GitHub repository.')
      await cloneProject(windowFor(event), repo)
    }),
  )
  handleLegacy(Invoke.newProject, (event, name: unknown, template: unknown) =>
    reportError(async () => {
      if (!isString(name)) throw new Error('Enter a name for the project.')
      await newProject(windowFor(event), name, isProjectTemplate(template) ? template : 'blank')
    }),
  )
  handleLegacy(Invoke.openRecent, async (event, root: unknown) => {
    if (!isString(root)) return
    // Only paths the user opened before; anything else goes through the folder picker.
    if (!(await loadRecent()).some((project) => project.root === root)) return
    openSafely(windowFor(event), root)
  })
  handleLegacy(
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
  handleLegacy(Invoke.showToolbarMenu, async (event, items: unknown, at: unknown) => {
    const win = windowFor(event)
    const valid = toolbarMenuItems(items)
    // The window's own chrome only, where the toolbar is.
    if (!win || win.win.webContents !== event.sender || !valid || !isPoint(at)) return null
    return showToolbarMenu(win.win, valid, at)
  })
  handleLegacy(Invoke.takeScreenshot, (event, at: unknown) => {
    const tab = tabFor(event)
    return tab?.screenshotMenu(event.sender, isPoint(at) ? at : null) ?? null
  })
  handleLegacy(Invoke.restoreTurn, (event, turnId: unknown) => {
    if (!isString(turnId)) throw new IpcRequestError('invalid_request', 'Invalid turn.')
    return requireTab(event).restoreTurn(turnId)
  })
  handleLegacy(Invoke.listVersions, (event) => tabFor(event)?.listVersions() ?? null)
  handleLegacy(Invoke.saveVersion, (event, name: unknown) => {
    if (!isString(name) || name.length > 1000)
      throw new IpcRequestError('invalid_request', 'Invalid version name.')
    return requireTab(event).saveVersion(name)
  })
  handleLegacy(Invoke.restoreVersion, (event, id: unknown) => {
    if (!isString(id) || id.length > 200)
      throw new IpcRequestError('invalid_request', 'Invalid version.')
    return requireTab(event).restoreVersion(id)
  })
  handleLegacy(Invoke.redo, (event) => requireTab(event).redo())
  handleLegacy(Invoke.fixProblems, (event) => tabFor(event)?.fixProblems() ?? false)
  handleLegacy(Invoke.fixStartup, (event) => tabFor(event)?.fixStartup() ?? false)
  handleLegacy(Invoke.setStartCommand, (event, start: unknown) =>
    reportError(async () => {
      // What runs in the user's shell is set from the window's own chrome only (see `onDrawer`).
      if (windowFor(event)?.win.webContents !== event.sender)
        throw new Error('This action is available only from Gui’s own UI.')
      if (start !== null && !isStartCommandInput(start))
        throw new Error('That start command is malformed.')
      await requireTab(event).setStartCommand(start)
    }),
  )
  handleLegacy(Invoke.chatSignIn, (event) => tabFor(event)?.signInAgain() ?? false)
  handleLegacy(Invoke.chatSetUpAgent, (event) => requireTab(event).setUpAgent())
  handleLegacy(Invoke.loadCommands, (event) => tabFor(event)?.loadCommands())
  const chatRequest = {
    authorize: (event: IpcMainInvokeEvent) => !!windowFor(event),
    validate: noRequestArgs,
  }
  handleRequest(Invoke.listChats, chatRequest, (event) => requireTab(event).listChats())
  handleRequest(Invoke.openChat, { ...chatRequest, validate: stringRequestArgs(1) }, (event, id) =>
    requireTab(event).openChat(id),
  )
  handleRequest(
    Invoke.renameChat,
    {
      ...chatRequest,
      validate: (args) =>
        args.length === 2 && isString(args[0]) && args[0].length > 0 && isString(args[1]),
    },
    (event, id, title) => requireTab(event).renameChat(id, title),
  )
  handleRequest(
    Invoke.deleteChat,
    { ...chatRequest, validate: stringRequestArgs(1) },
    (event, id) => requireTab(event).deleteChat(id),
  )
  handleLegacy(Invoke.signIn, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.signIn(agentId)
  })
  handleLegacy(Invoke.installAgent, async (event, agentId: unknown) => {
    if (fromAppUi(event) && isAgentId(agentId)) await agentHealth.install(agentId)
  })
  handleLegacy(Invoke.connectAgent, async (event, agentId: unknown) => {
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
  const onWindow = createWindowMessageRegistrar<IpcMainEvent, ProjectWindow>(
    (channel, listener) => ipcMain.on(channel, listener),
    windowFor,
  )

  // Starting it runs the project's command: from the window's chrome only (see `onDrawer`).
  onWindow(Send.devServerStart, (win) => win.activeTab.startDevServer())
  on(Send.devServerStop, (tab) => tab.stopDevServer())
  onWindow(Send.devServerRestart, (win) => win.activeTab.restartDevServer())
  on(Send.showDevServerMenu, (tab) => tab.showDevServerMenu())
  ipcMain.on(Send.showAgentMenu, (event, at: unknown) => {
    const point = isPoint(at) ? at : null
    tabFor(event)?.showAgentMenu(() => openSettings('agents'), event.sender, point)
  })
  ipcMain.on(Send.showChatMenu, (event, at: unknown) => {
    if (isPoint(at)) tabFor(event)?.showChatMenu(at)
  })
  onWindow(Send.showProjectMenu, (win) =>
    win.activeTab.showProjectMenu(
      () => void pickProject(win),
      () => win.showStartForm('newProject'),
      () => void newBoard(win),
      () => win.showStartForm('cloneRepo'),
      (root) => openSafely(win, root),
    ),
  )
  on(Send.setAgent, (tab, agentId) => isAgentId(agentId) && tab.setAgent(agentId))
  registerBoardIpc(onWindow, {
    create: newBoard,
    open: openBoardIn,
    recentMenu: showRecentBoardMenu,
    promote: promoteFrame,
  })
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
  onDrawer(Send.focusPreview, (tab) => tab.focusPreview())
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

  const handleSettings = <C extends LegacyChannel>(
    channel: C,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: AllRequestArgs<C>
    ) => LegacyResult<C> | Promise<LegacyResult<C>>,
  ) => {
    handleLegacy(channel, (event, ...args) => {
      if (!fromSettings(event))
        throw new IpcRequestError(
          'forbidden',
          'Settings are available only from Gui’s Settings window.',
        )
      return handler(event, ...args)
    })
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
  handleSettings(Invoke.resetStartCommand, (_event, root) =>
    isString(root) ? resetStartCommand(root) : undefined,
  )
  handleSettings(Invoke.clearRecent, () => clearRecent())
  handleLegacy(Invoke.removeRecent, (event, root: unknown) =>
    fromAppUi(event) && isString(root) ? removeRecent(root) : undefined,
  )
  handleLegacy(Invoke.archiveRecentChat, (event, root: unknown) =>
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
  onSettings(Send.setChatSidebarSide, (side) => {
    if (side === 'left' || side === 'right') setChatSidebarSide(side)
  })
  onSettings(Send.setCrashReports, (on) => typeof on === 'boolean' && setCrashReports(on))
  onSettings(Send.openCustomAgentsFile, () => void openCustomAgents())
  ipcMain.on(Send.reportError, (event, error: unknown) => {
    if (!isAppContents(event.sender) || !error || typeof error !== 'object') return
    const { message, stack } = error as Record<string, unknown>
    if (!isString(message)) return
    sendCrashReport({ kind: 'window', message, stack: isString(stack) ? stack : undefined })
  })
  on(Send.navigate, (tab, url) => isString(url) && tab.navigate(url))
  on(Send.backToApp, (tab) => tab.backToApp())
  on(Send.back, (tab) => tab.back())
  on(Send.forward, (tab) => tab.forward())
  on(Send.reload, (tab) => tab.reload())
  on(Send.setViewport, (tab, viewport) => {
    // A custom size only when it's the open canvas frame's own (the tab checks).
    if (isViewport(viewport) || isCustomViewport(viewport)) tab.setViewport(viewport)
  })
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
  on(Send.endGuide, (tab) => tab.endGuide())
  on(Send.variations, (tab, action) => {
    if (VARIATION_ACTIONS.includes(action as VariationAction))
      tab.variationsAction(action as VariationAction)
  })
  on(Send.variationsSize, (tab, width, height) => {
    if (isNumber(width) && isNumber(height)) tab.variationsSize(width, height)
  })
  /** From a preview's own preload, in its page's top frame: the tab whose preview it is. */
  const previewTab = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.senderFrame === event.sender.mainFrame
      ? allTabs().find((tab) => tab.ownsPreview(event.sender))
      : undefined
  const isPreviewText = (value: unknown): value is string =>
    isString(value) && value.length <= MAX_PREVIEW_TEXT
  ipcMain.handle(PreviewText.start, (event, at: unknown, text: unknown) => {
    const tab = previewTab(event)
    return tab && isPoint(at) && isPreviewText(text) ? tab.startTextEdit(at, text) : null
  })
  ipcMain.on(PreviewText.end, (event, id: unknown, text: unknown) => {
    if (isString(id) && (text === null || isPreviewText(text)))
      previewTab(event)?.endTextEdit(id, text)
  })
  ipcMain.on(PreviewGuides.scroll, (event, x: unknown, y: unknown) => {
    if (isNumber(x) && isNumber(y)) previewTab(event)?.previewScrolled(x, y)
  })
  ipcMain.on(PreviewGuides.toggle, (event) => {
    if (previewTab(event)) toggleRulers()
  })
  on(Send.toggleRulers, () => toggleRulers())
  // The preview's find bar, in the window's chrome.
  onWindow(Send.findInPage, (win, text, forward, fresh) => {
    if (!isString(text) || text.length > MAX_FIND_TEXT) return
    if (typeof forward === 'boolean' && typeof fresh === 'boolean')
      win.activeTab.findInPage(text, forward, fresh)
  })
  onWindow(Send.stopFindInPage, (win) => win.activeTab.stopFindInPage())
  on(Send.rulerDrag, (tab, axis, phase, at) => {
    if ((axis === 'x' || axis === 'y') && isPoint(at) && isRulerPhase(phase))
      tab.rulerDrag(axis, phase, at)
  })
  on(Send.guidePointer, (tab, id, phase, at) => {
    if (isString(id) && GUIDE_POINTER_PHASES.includes(phase as GuidePointerPhase) && isPoint(at))
      tab.guidePointer(id, phase as GuidePointerPhase, at)
  })
  onWindow(Send.setCanvasRect, (win, rect) => isRect(rect) && win.setCanvasRect(rect))
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
  on(Send.clearQueued, (tab) => tab.clearQueued())
  on(Send.editQueued, (tab, id, text) => isString(id) && isString(text) && tab.editQueued(id, text))
  on(Send.moveQueued, (tab, id, index) => {
    if (isString(id) && isNumber(index)) tab.moveQueued(id, index)
  })
  on(Send.sendQueuedNow, (tab) => tab.sendQueuedNow())
  on(Send.sendQueued, (tab, id) => isString(id) && tab.sendQueued(id))
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
  on(Send.chatCollapsed, (tab, seq) => isNumber(seq) && tab.chatCollapsed(seq))
  on(Send.chatBoxHeight, (tab, height) => isNumber(height) && tab.chatBoxHeight(height))
  on(Send.holdChat, (tab, held) => tab.holdChat(held === true))
  on(Send.chatDrafted, (tab, drafted) => tab.chatDrafted(drafted === true))
  on(Send.resizeChat, (tab, edge, dx, dy) => {
    if (isPanelEdge(edge) && isNumber(dx) && isNumber(dy)) tab.resizeChat(edge, dx, dy)
  })
  on(Send.endResizeChat, (tab) => tab.endResizeChat())
  // Setup runs commands and writes files in the project: from the window's chrome only.
  onWindow(Send.chooseApp, (win, dir) => isString(dir) && win.activeTab.chooseApp(dir))
  onWindow(Send.installDependencies, (win) => win.activeTab.installDependencies())
  onWindow(Send.createEnvFile, (win) => win.activeTab.createEnvFile())
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
  // A narrated one may also open the microphone, once, and never a camera.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const capture = wc ? captures.get(wc.id) : undefined
    const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
    if (capture?.mic && permission === 'media' && types.length === 1 && types[0] === 'audio') {
      capture.mic = false
      callback(true)
      return
    }
    callback(
      capture?.armed === true &&
        (permission === 'display-capture' || (permission === 'media' && types.length === 0)),
    )
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    const capture = wc ? captures.get(wc.id) : undefined
    if (!capture) return false
    if (capture.mic && permission === 'media' && details.mediaType === 'audio') return true
    return capture.armed && (permission === 'media' || permission === 'display-capture')
  })
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
 * otherwise, including from an empty chat box, they undo or redo the agent's last change
 * while the chat is showing (beeping when it's hidden).
 */
async function editHistory(direction: 'undo' | 'redo') {
  const wc = webContents.getFocusedWebContents()
  const textEdit = () => (direction === 'undo' ? wc?.undo() : wc?.redo())
  if (wc && !wc.isDestroyed() && (await isEditingText(wc))) return textEdit()
  const tab = menuTab()
  if (!tab) return textEdit()
  // On a canvas, the user's own board changes come back before the agent's turns do; with a
  // frame open live, only they do (undoBoard). The board has no redo of its own: ⇧⌘Z is the
  // chat's, as in a project.
  if (direction === 'undo' && (await tab.undoBoard())) return
  await (direction === 'undo' ? tab.undoLastChange() : tab.redoLastChange())
}

const AUTO_MODE_ITEM = 'auto-mode'
const MOVE_TAB_ITEM = 'move-tab'
const REOPEN_TAB_ITEM = 'reopen-tab'
const ALLOW_ITEM = 'allow'
const DONT_ALLOW_ITEM = 'dont-allow'
const FOCUS_MODE_ITEM = 'focus-mode'
const RULERS_ITEM = 'rulers'
const SHOW_CHAT_ITEM = 'show-chat'
const HIDE_CHAT_ITEM = 'hide-chat'
const SHOW_TERMINAL_ITEM = 'show-terminal'
const HIDE_TERMINAL_ITEM = 'hide-terminal'

type SyncedItem = Pick<MenuItemConstructorOptions, 'checked' | 'enabled' | 'visible'>

/**
 * Menu items that follow the window menus act on: View → Focus Mode is checked while the
 * window's in it; Agent → Auto Mode is checked when the project it would change is in Auto
 * mode; Allow and Don't Allow answer a permission card
 * that's waiting (see `permissionAnswer`); Window → Move Tab to New Window needs a second tab,
 * and File → Reopen Closed Tab a tab closed in the window.
 * View → Show Chat or Hide Chat, and Show Terminal or Hide Terminal, say what ⌘B and ⌘J
 * will do (menu-toggles.ts).
 *
 * Their keys reach a page first: ⌘⌫ deletes typing in a text field, and the chat panel
 * answers ⌘↩ and ⌘⌫ itself (chat-panel.tsx), so only keys nothing else took get here.
 */
function syncedItemStates(): Record<string, SyncedItem> {
  const tab = menuTab()
  const focusMode = menuWindow()?.focusMode ?? false
  const hideChat =
    !!tab &&
    chatWillHide({ chatVisible: tab.state.chatVisible, poppedOut: !!tab.popoutWindow, focusMode })
  const hideTerminal = !!tab && terminalWillHide({ drawerOpen: tab.state.drawer.open, focusMode })
  return {
    [SHOW_CHAT_ITEM]: { visible: !hideChat },
    [HIDE_CHAT_ITEM]: { visible: hideChat },
    [SHOW_TERMINAL_ITEM]: { visible: !hideTerminal },
    [HIDE_TERMINAL_ITEM]: { visible: hideTerminal },
    [FOCUS_MODE_ITEM]: { checked: menuWindow()?.focusMode ?? false },
    [RULERS_ITEM]: { checked: getPrefs().rulers },
    [AUTO_MODE_ITEM]: { checked: tab?.autoApprove ?? false },
    [ALLOW_ITEM]: { enabled: !!tab?.permissionAnswer(true) },
    [DONT_ALLOW_ITEM]: { enabled: !!tab?.permissionAnswer(false) },
    [MOVE_TAB_ITEM]: { enabled: (menuWindow()?.tabs.length ?? 0) > 1 },
    [REOPEN_TAB_ITEM]: { enabled: menuWindow()?.canReopenTab ?? false },
  }
}

function syncMenuItems() {
  const menu = Menu.getApplicationMenu()
  for (const [id, { checked, enabled, visible }] of Object.entries(syncedItemStates())) {
    const item = menu?.getMenuItemById(id)
    if (!item) continue
    if (checked !== undefined && item.checked !== checked) item.checked = checked
    if (enabled !== undefined && item.enabled !== enabled) item.enabled = enabled
    if (visible !== undefined && item.visible !== visible) item.visible = visible
  }
}

/**
 * ⇧R or View → Rulers: the rulers and guides over every preview, on or off. The keys come
 * from a page (the preview's preload, the chrome), each outside its text fields, so a capital
 * R typed anywhere still types; the menu item has no keys of its own for the same reason.
 */
function toggleRulers() {
  setPrefs({ rulers: !getPrefs().rulers })
}

/** Only from the user's own menu choice or keystroke: agents never get to turn this on. */
function toggleAutoMode() {
  const tab = menuTab()
  tab?.setAutoApprove(!tab.autoApprove)
  // The click already flipped the checkmark; it follows the project's setting instead.
  syncMenuItems()
}

/**
 * ⌘F, ⌘G and ⇧⌘G: find in what has the keyboard, in the window menus act on (`find` in
 * window.ts). A text field doesn't take these keys, so they come here from one too.
 */
function find(action: FindAction) {
  const win = menuWindow()
  if (!win || win.win.isMinimized()) return
  const focused = webContents.getFocusedWebContents()
  const focus = !focused
    ? 'none'
    : focused === win.win.webContents
      ? 'chrome'
      : win.activeTab.ownsPreview(focused)
        ? 'preview'
        : 'chat'
  void win.find(action, focus)
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

/**
 * ⇧⌘T: the window's tab closed last, back where it was, as a fresh opening of its project or
 * canvas: its chat as saved, its dev server started again. One whose folder is gone is
 * skipped for the one closed before it.
 */
async function reopenClosedTab() {
  const win = menuWindow()
  if (!win || win.win.isMinimized()) return
  while (win.canReopenTab) {
    const reopened = win.reopenTab()
    if (!reopened) break
    const { closed, tab } = reopened
    if (!(await isDirectory(closed.root))) {
      if (win.tabs.includes(tab)) win.closeTab(tab.id)
      continue
    }
    if (closed.kind === 'canvas') {
      const id = boardIdOf(closed.root)
      if (id) await openBoardIn(win, id, tab)
      // Open in another tab already, which showed instead: the empty one isn't needed.
      if (!tab.hasProject && win.tabs.includes(tab)) win.closeTab(tab.id)
    } else openSafely(win, closed.root, tab)
    return
  }
  shell.beep()
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
    (fn: (tab: ProjectTab, byKey: boolean) => void): MenuItemConstructorOptions['click'] =>
    (_item, _win, event) => {
      const tab = menuTab()
      // From the item's shortcut rather than the menu bar (no event when clicked from code)
      if (tab) fn(tab, event?.triggeredByAccelerator === true)
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
  /**
   * A show-or-hide shortcut's two items on the same keys ("Show Chat", "Hide Chat"), only one
   * of them shown (`syncMenuItems`). The hidden one's keys don't work: a keystroke runs the
   * item the menu shows.
   */
  const showOrHide = (
    id: ShortcutId,
    showId: string,
    hideId: string,
    fn: (tab: ProjectTab) => void,
  ): MenuItemConstructorOptions[] => {
    const { menuLabels }: ShortcutSpec = SHORTCUTS[id]
    if (!menuLabels) throw new Error(`${id} has no Show and Hide labels`)
    return [
      { id: showId, label: menuLabels.show },
      { id: hideId, label: menuLabels.hide },
    ].flatMap(({ id: itemId, label }) =>
      item(id, {
        id: itemId,
        label,
        ...synced[itemId],
        acceleratorWorksWhenHidden: false,
        click: withWindow(fn),
      }),
    )
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void checkForUpdatesByHand() },
        { type: 'separator' },
        ...item('settings', { click: () => openSettings() }),
        { label: "Install 'gui' Command…", click: () => void installCli() },
        { label: 'Remove Agent Skill…', click: () => void removeAgentSkill() },
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
        ...item('newBoard', { click: () => void newBoard(focusedWindow()) }),
        ...item('cloneRepo', {
          click: () => startForm('cloneRepo'),
        }),
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        ...item('closeTab', { click: closeTab }),
        ...item('closeWindow', { role: 'close' }),
        ...item('reopenClosedTab', {
          id: REOPEN_TAB_ITEM,
          ...synced[REOPEN_TAB_ITEM],
          click: () => void reopenClosedTab(),
        }),
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
        { type: 'separator' },
        {
          label: 'Find',
          submenu: [
            ...item('find', { click: () => find('show') }),
            ...item('findNext', { click: () => find('next') }),
            ...item('findPrevious', { click: () => find('previous') }),
          ],
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...item('selectElement', { click: withWindow((w) => void w.toggleSelect()) }),
        // ⌘B shows or hides the chat, like a sidebar; ⌘L puts the cursor in it (Cursor's ⌘L).
        ...showOrHide('toggleChat', SHOW_CHAT_ITEM, HIDE_CHAT_ITEM, (w) => w.toggleChat()),
        ...item('focusMessageBox', { click: withWindow((w) => w.focusMessageBox()) }),
        ...item('dockChat', { click: withWindow((w) => w.toggleDock()) }),
        ...item('popOutChat', { click: withWindow((w) => w.togglePopOut()) }),
        // The drawer under the canvas, as VS Code's ⌘J toggles its panel.
        ...showOrHide('toggleTerminal', SHOW_TERMINAL_ITEM, HIDE_TERMINAL_ITEM, (w) =>
          w.toggleDrawer(),
        ),
        { type: 'separator' },
        ...item('nextPane', { click: withWindow((w) => w.focusPane(1)) }),
        ...item('previousPane', { click: withWindow((w) => w.focusPane(-1)) }),
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
        // From the keyboard, zoom lands at once: ⌘+ pressed again and again shouldn't make
        // the page lay itself out at every size in between.
        ...item('zoomIn', { click: withWindow((w, byKey) => w.zoom(1, !byKey)) }),
        ...item('zoomOut', { click: withWindow((w, byKey) => w.zoom(-1, !byKey)) }),
        ...item('actualSize', { click: withWindow((w, byKey) => w.zoom(0, !byKey)) }),
        { type: 'separator' },
        ...item('screenshot', { click: withTabs((w) => w.screenshot()) }),
        ...item('recordPreview', { click: withTabs((w) => w.recordPreview()) }),
        {
          id: RULERS_ITEM,
          label: 'Rulers',
          type: 'checkbox',
          ...synced[RULERS_ITEM],
          click: () => {
            toggleRulers()
            syncMenuItems()
          },
        },
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
        { type: 'separator' },
        { label: 'Contact Support', click: () => void shell.openExternal(supportMail()) },
        { label: 'Gui Website', click: () => void shell.openExternal('https://usegui.com') },
        { label: 'Privacy', click: () => void shell.openExternal('https://usegui.com/privacy') },
        { label: 'Terms', click: () => void shell.openExternal('https://usegui.com/terms') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** An email to support that already says which Gui and which macOS. */
function supportMail() {
  const body = `\n\n—\nGui ${app.getVersion()}, macOS ${process.getSystemVersion()} (${process.arch})`
  return `mailto:hello@usegui.com?subject=${encodeURIComponent('Gui support')}&body=${encodeURIComponent(body)}`
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

/**
 * Work that can wait until the first window is on screen: a moment after it shows, or after a
 * few seconds if it doesn't (opened in the background).
 */
function afterFirstWindow(win: BrowserWindow, run: () => void) {
  let started = false
  const start = () => {
    if (started) return
    started = true
    setTimeout(run, 1000)
  }
  win.once('show', start)
  setTimeout(start, 4000)
}

/** Stops agent processes that would otherwise outlive the app. */
function shutdown() {
  for (const win of allWindows()) win.destroy()
  // Terminals and dev servers stop in the background; nothing runs after this to finish it.
  finishEndingSync()
  flushHistorySync()
  // A preference changed a moment ago may still be on its way to disk; after the windows,
  // which are the last thing that could change one.
  flushPrefsSync()
  agentHealth.dispose()
  nodeRuntime.dispose()
  killStoppedAgents()
}

// A rejected promise nothing awaited is logged rather than lost, and reported.
process.on('unhandledRejection', (reason) => {
  console.error('[gui] unhandled rejection', reason)
  sendCrashReport(errorReport('rejection', reason))
})
// A monitor, not a handler: Electron still shows its error dialog as before.
process.on('uncaughtExceptionMonitor', (error) => sendCrashReport(errorReport('main', error)))
// Helper processes (GPU, network, utility); renderers are reported in renderer.ts.
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return
  sendCrashReport({
    kind: 'process',
    message: `${details.type} process gone (${details.reason}, exit code ${details.exitCode})${details.name ? ` ${details.name}` : ''}`,
  })
})

// One Gui per data folder: two would delete each other's live shadow-repo lock and
// overwrite each other's history. The lock is keyed on userData, so a dev build or a
// test with its own --user-data-dir still runs alongside.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Reading the login shell's environment takes about half a second. Started before `ready`,
  // it's usually done by the time the first project's dev server or agent needs it.
  void getShellEnv()
  app.on('second-instance', () => focusExistingWindow())

  app.on('open-file', (event, path) => {
    event.preventDefault()
    // At cold launch no window is focused yet; reuse the empty one created on ready.
    void app.whenReady().then(() => openOrShow(path))
  })

  app.whenReady().then(() => {
    lockDownSessions()
    registerRecordingProtocol()
    registerThumbProtocol()
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
    const initial = !app.isPackaged ? process.env.GUI_OPEN : undefined
    if (initial) openSafely(win, resolve(initial))
    afterFirstWindow(win.win, () => {
      startUpdates()
      preloadMcpSdk()
    })
  })

  app.on('before-quit', shutdown)
  app.on('will-quit', shutdown)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
