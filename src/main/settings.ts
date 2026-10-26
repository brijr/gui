import { app, BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from 'electron'
import { Events } from '../shared/ipc'
import { TRAFFIC_LIGHTS } from '../shared/layout'
import {
  type AgentId,
  CUSTOM_AGENT_PREFIX,
  type CustomAgentEntry,
  DEFAULT_AGENT_ID,
  type SettingsSection,
  type SettingsState,
  type StorageKind,
  type StorageUsage,
} from '../shared/types'
import { agentHealth } from './agent-status'
import { customAgentEntries, deleteCustomAgent, saveCustomAgent } from './agents'
import { archiveStoredChat, historyFile } from './history'
import { getPrefs, prefsEvents, setPrefs } from './prefs'
import {
  clearRecent as clearRecentFile,
  loadRecent,
  removeRecent as removeRecentFile,
  withChats,
} from './recent'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'
import { listStartCommands, saveStartCommand } from './start-commands'
import { clearStorage as clearStorageData, measureStorage } from './storage'
import { followSurface, surfaceColor } from './theme'
import { listTrusted, untrust } from './trust'
import { allTabs, focusWindow, showWindow } from './window'

let win: BrowserWindow | null = null
/** Section to show once the Settings page has loaded and asked for its state. */
let pendingSection: SettingsSection | null = null
let storage: StorageUsage = { chats: null, checkpoints: null, previewData: null }
/** Bumped per refresh, so a slow one can't overwrite a newer state. */
let generation = 0

const customId = (name: string): AgentId => `${CUSTOM_AGENT_PREFIX}${name}`
const openRoots = () => allTabs().flatMap((tab) => (tab.projectRoot ? [tab.projectRoot] : []))
const live = (window: BrowserWindow | null): window is BrowserWindow =>
  window !== null && !window.isDestroyed()

export function isSettingsContents(wc: WebContents) {
  return live(win) && wc === win.webContents
}

/** Keeps an open Settings window in sync with agents and preferences. */
export function watchSettings() {
  agentHealth.on('change', () => void refreshSettings())
  prefsEvents.on('change', () => void refreshSettings())
}

export function openSettings(section?: SettingsSection) {
  if (live(win)) {
    if (section) win.webContents.send(Events.settingsSection, section)
    showWindow(win)
    focusWindow(win)
    return
  }
  pendingSection = section ?? null
  const window = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 640,
    minHeight: 460,
    show: false,
    title: 'Settings',
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHTS,
    // Solid, not the system's sidebar material: that takes on whatever is behind the window
    // (a dark window darkens it even in light mode), and the sidebar's labels vanished on it.
    backgroundColor: surfaceColor(),
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
  })
  followSurface(window)
  win = window
  guardAppContents(window.webContents)
  window.once('ready-to-show', () => showWindow(window))
  window.on('closed', () => {
    if (win === window) win = null
  })
  loadRenderer(window.webContents, 'settings').catch((error) =>
    console.error('[gui] failed to load settings', error),
  )
  void agentHealth.rescan()
  void remeasure()
}

/** The state the Settings page renders; also delivers a section it was opened at. */
export async function getSettings(sender: WebContents): Promise<SettingsState> {
  const state = await buildState()
  const section = pendingSection
  if (section && isSettingsContents(sender)) {
    pendingSection = null
    // After the reply, so the page has subscribed by the time it arrives.
    setTimeout(() => {
      if (!sender.isDestroyed()) sender.send(Events.settingsSection, section)
    }, 0)
  }
  return state
}

async function buildState(): Promise<SettingsState> {
  const prefs = getPrefs()
  const [custom, trustedProjects, startCommands, recentProjects] = await Promise.all([
    customAgentEntries(),
    listTrusted(),
    listStartCommands(),
    loadRecent(),
  ])
  return {
    agents: agentHealth.list(),
    defaultAgentId: prefs.agentId,
    chatSidebar: prefs.chatSidebar,
    chatSidebarSide: prefs.chatSidebarSide,
    customAgents: custom.entries,
    customAgentsError: custom.error,
    trustedProjects,
    startCommands,
    defaultBranchProjects: prefs.defaultBranchRoots,
    recentProjects,
    storage,
    openProjects: openRoots(),
    home: app.getPath('home'),
    crashReports: prefs.crashReports,
  }
}

export async function refreshSettings() {
  if (!live(win)) return
  const current = ++generation
  const state = await buildState()
  if (current === generation && live(win)) win.webContents.send(Events.settings, state)
}

async function remeasure() {
  storage = await measureStorage()
  await refreshSettings()
}

export function setAgentEnabled(id: AgentId, enabled: boolean) {
  const disabled = new Set(getPrefs().disabledAgents)
  if (enabled) disabled.delete(id)
  else disabled.add(id)
  setPrefs({ disabledAgents: [...disabled] })
}

/** Only an agent Gui knows (built in or in agents.json) can be the default. */
export function setDefaultAgent(id: AgentId) {
  if (!agentHealth.has(id)) return
  agentHealth.ensureChecked(id)
  setPrefs({ agentId: id })
}

export function setChatSidebarSide(side: 'left' | 'right') {
  setPrefs({ chatSidebarSide: side })
  for (const tab of allTabs()) tab.setChatSidebarSide(side)
}

export function setChatDocked(docked: boolean) {
  setPrefs({ chatSidebar: docked })
}

export function setCrashReports(on: boolean) {
  setPrefs({ crashReports: on })
}

export async function saveCustom(originalName: string | null, entry: CustomAgentEntry) {
  await saveCustomAgent(originalName, entry)
  const name = entry.name.trim()
  if (originalName !== null && originalName !== name) {
    // A rename keeps it the default agent and keeps it switched off if it was.
    const from = customId(originalName)
    const to = customId(name)
    const prefs = getPrefs()
    setPrefs({
      agentId: prefs.agentId === from ? to : prefs.agentId,
      disabledAgents: prefs.disabledAgents.map((id) => (id === from ? to : id)),
    })
  }
  await agentHealth.rescan()
  await refreshSettings()
}

export async function deleteCustom(name: string) {
  await deleteCustomAgent(name)
  const id = customId(name)
  const prefs = getPrefs()
  if (prefs.agentId === id || prefs.disabledAgents.includes(id)) {
    setPrefs({
      agentId: prefs.agentId === id ? DEFAULT_AGENT_ID : prefs.agentId,
      disabledAgents: prefs.disabledAgents.filter((agent) => agent !== id),
    })
  }
  await agentHealth.rescan()
  await refreshSettings()
}

export async function untrustProject(root: string) {
  await untrust(root)
  await refreshSettings()
}

/** Back to the command Gui detects; a tab with the project open starts it that way now. */
export async function resetStartCommand(root: string) {
  await saveStartCommand(root, null)
  for (const tab of allTabs()) {
    if (tab.projectRoot === root && tab.getState().project?.custom) void tab.retryStartup()
  }
  await refreshSettings()
}

/** The next time the project opens on its main branch, it asks where to work again. */
export async function askAboutBranch(root: string) {
  const roots = getPrefs().defaultBranchRoots
  if (roots.includes(root))
    setPrefs({ defaultBranchRoots: roots.filter((saved) => saved !== root) })
  await refreshSettings()
}

export async function clearRecent() {
  await clearRecentFile()
  for (const tab of allTabs()) tab.setRecent([])
  await refreshSettings()
}

export async function removeRecent(root: string) {
  const recent = await withChats(await removeRecentFile(root))
  for (const tab of allTabs()) tab.setRecent(recent)
  await refreshSettings()
}

/**
 * Archives a project's own chat from the start screen: through the tab that has it open,
 * whose chat is live, or else from its file.
 */
export async function archiveRecentChat(root: string) {
  const file = await historyFile(root)
  const tab = allTabs().find((each) => each.chatFile === file)
  if (tab) {
    if (!(await tab.archiveChat())) throw new Error("This chat couldn't be archived.")
  } else if (!(await archiveStoredChat(root))) {
    throw new Error('This chat is open in another tab.')
  }
  const recent = await withChats(await loadRecent())
  for (const each of allTabs()) each.setRecent(recent)
  await refreshSettings()
}

const CLEAR_PROMPTS: Record<StorageKind, { message: string; detail: string }> = {
  chats: {
    message: 'Clear chat history?',
    detail: 'Saved transcripts, archived chats, and resumable agent sessions are deleted.',
  },
  checkpoints: {
    message: 'Clear checkpoints?',
    detail: 'Turns in past chats can no longer be undone.',
  },
  previewData: {
    message: 'Clear preview data?',
    detail:
      "Cookies, local storage, and cache of the apps you've previewed are deleted, which signs you out of them.",
  },
}

/** Asks first; resolves false when the user cancels. */
export async function confirmAndClear(kind: StorageKind) {
  const open = openRoots()
  const prompt = CLEAR_PROMPTS[kind]
  const keepsOpen = kind !== 'previewData' && open.length > 0
  const options: MessageBoxOptions = {
    type: 'warning',
    message: prompt.message,
    detail: keepsOpen ? `${prompt.detail} Projects open in a tab keep theirs.` : prompt.detail,
    buttons: ['Clear', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  }
  const { response } = live(win)
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (response !== 0) return false
  // Projects opened while the dialog was up keep theirs too.
  await clearStorageData(kind, openRoots())
  await remeasure()
  return true
}
