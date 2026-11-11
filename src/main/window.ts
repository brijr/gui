import { EventEmitter } from 'node:events'
import { BrowserWindow, Menu, shell, type WebContents } from 'electron'
import { type FindAction, type FindCommand, type FindContext, findArea } from '../shared/find'
import { Events, type StartForm } from '../shared/ipc'
import {
  FOCUS_BAR_HEIGHT,
  FOCUS_TRAFFIC_LIGHTS,
  TAB_ROW_HEIGHT,
  TAB_ROW_TRAFFIC_LIGHTS,
  TOOLBAR_HEIGHT,
  TRAFFIC_LIGHTS,
} from '../shared/layout'
import type { RecentBoard, RecentProject, Rect, TabInfo, WindowState } from '../shared/types'
import { boardIdOf } from './board'
import { type ClosedTab, ClosedTabs, reopenIndex } from './closed-tabs'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'
import { ProjectTab, type TabHost } from './tab'
import { followSurface, surfaceColor } from './theme'
import { focusWindow, showWindow } from './window-presentation'

export { focusWindow, keepInBackground, showWindow } from './window-presentation'

const windows = new Set<ProjectWindow>()
/** The window focused last, for opening a project while Gui is in the background. */
let lastFocused: ProjectWindow | null = null

/**
 * How long the shortcuts sheet takes to fade out (lib/dialog.tsx closes in --motion-pop, with
 * or without reduced motion, in styles.css). The tab's views wait it out.
 */
const SHEET_EXIT_MS = 160

/**
 * A window showed another tab, so menus that act on the active tab may now mean another; or
 * its tabs changed, which menus that act on its tabs follow; or its active tab changed in a
 * way menus may follow (a permission card came or went).
 */
export const windowEvents = new EventEmitter<{ activeTab: []; tabs: []; changed: [] }>()

/** The window a page belongs to: its chrome, or one of its tabs' chat panels. */
export function findWindow(sender: WebContents) {
  for (const win of windows) if (win.owns(sender)) return win
  return undefined
}

/** The tab a page acts on: a chat panel's own tab, or the active tab for a window's chrome. */
export function findTab(sender: WebContents) {
  return findWindow(sender)?.tabFor(sender)
}

/** The focused project window, counting its tab's popped-out chat as part of it. */
export function focusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return undefined
  for (const win of windows) {
    if (win.win === focused || win.tabs.some((tab) => tab.popoutWindow === focused)) return win
  }
  return undefined
}

/** The focused window, or the one focused last while Gui is in the background. */
export function lastFocusedWindow() {
  const last = lastFocused && windows.has(lastFocused) ? lastFocused : undefined
  return focusedWindow() ?? last ?? allWindows()[0]
}

export function allWindows() {
  return [...windows]
}

export function allTabs() {
  return allWindows().flatMap((win) => win.tabs)
}

/** Every tab's start screen lists the canvases as they are now. */
export function shareBoards(boards: RecentBoard[]) {
  for (const tab of allTabs()) tab.setRecentBoards(boards)
}

/**
 * A Gui window: the chrome renderer (tab strip, toolbar, canvas, logs) and its tabs, each a
 * project with its own preview, chat, dev server and agent (tab.ts). The active tab's views
 * are in the window and the chrome shows its state; the other tabs keep running unseen.
 */
export class ProjectWindow implements TabHost {
  readonly win: BrowserWindow
  /** The chrome's canvas, reported by the renderer; the active tab lays out over it. */
  canvas: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private list: ProjectTab[]
  private active: ProjectTab
  /** The tab strip as last sent to the chrome, so a tab's status change resends it once. */
  private sentTabs = ''
  /** Where the traffic lights are: the toolbar's, the tab row's or focus mode's spot. */
  private lights: { x: number; y: number } = TRAFFIC_LIGHTS
  /** Focus mode (WindowState.focusMode). */
  private focus = false
  /** The Keyboard Shortcuts sheet is open (WindowState.shortcutsOpen). */
  private sheet = false
  /** The sheet has closed and is still fading out, with the tab's views kept hidden till then. */
  private sheetLeaving: NodeJS.Timeout | null = null
  /** Tabs closed in this window, for File → Reopen Closed Tab */
  private closed = new ClosedTabs()
  private disposed = false

  /** Opens with a start-screen tab, or with `tab`, moved here from another window. */
  constructor(tab?: ProjectTab) {
    this.win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: 'Gui',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHTS,
      backgroundColor: surfaceColor(),
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    })
    followSurface(this.win)
    guardAppContents(this.win.webContents)
    this.win.on('resize', () => this.active.layout())
    // Full screen hides the traffic lights; the chrome takes back the room it kept for them.
    // Full screen hides the traffic lights: the chrome and the sidebar's header take back
    // the room they kept for them.
    this.win.on('enter-full-screen', () => {
      this.sendState()
      this.active.layout()
    })
    this.win.on('leave-full-screen', () => {
      this.sendState()
      this.active.layout()
    })
    // The title is the active tab's project, not the chrome page's own.
    this.win.on('page-title-updated', (event) => event.preventDefault())
    this.win.on('focus', () => {
      lastFocused = this
      // A branch switched in Terminal meanwhile shows in the toolbar.
      void this.active.refreshBranch()
    })
    // Minimized or hidden (⌘H), nobody sees the chat in it: its page rests until it's back.
    // (On macOS show and hide follow what's really on screen; focus, in case one is missed.)
    const shownChanged = () => this.active.windowShownChanged()
    this.win.on('show', shownChanged)
    this.win.on('hide', shownChanged)
    this.win.on('minimize', shownChanged)
    this.win.on('restore', shownChanged)
    this.win.on('focus', shownChanged)
    this.win.once('ready-to-show', () => {
      showWindow(this.win)
      // Shown by us: said now, whatever macOS reports of it (nothing, opened behind others).
      shownChanged()
    })
    this.win.on('closed', () => this.dispose())
    loadRenderer(this.win.webContents, 'index').catch((error) =>
      console.error('[gui] failed to load index', error),
    )

    tab?.moveTo(this)
    this.active = tab ?? new ProjectTab(this)
    this.list = [this.active]
    windows.add(this)
    this.active.activate()
    this.syncChrome()
  }

  owns(wc: WebContents) {
    return wc === this.win.webContents || this.list.some((tab) => tab.owns(wc))
  }

  /** A chat panel's own tab; for the chrome, the tab it shows. */
  tabFor(wc: WebContents) {
    if (wc === this.win.webContents) return this.active
    return this.list.find((tab) => tab.owns(wc))
  }

  get tabs(): readonly ProjectTab[] {
    return this.list
  }

  get activeTab() {
    return this.active
  }

  get chromeHeight() {
    if (this.focus) return FOCUS_BAR_HEIGHT
    return TOOLBAR_HEIGHT + (this.list.length > 1 ? TAB_ROW_HEIGHT : 0)
  }

  get focusMode() {
    return this.focus
  }

  get shortcutsOpen() {
    return this.sheet
  }

  get sheetShown() {
    return this.sheet || this.sheetLeaving !== null
  }

  isActive(tab: ProjectTab) {
    return tab === this.active && !this.disposed
  }

  /** The active tab's state, with the tab strip. */
  getState(): WindowState {
    return {
      ...this.active.getState(),
      tabs: this.tabInfos(),
      activeTab: this.active.id,
      focusMode: this.focus,
      shortcutsOpen: this.sheet,
      fullScreen: this.win.isFullScreen(),
    }
  }

  setCanvasRect(rect: Rect) {
    this.canvas = rect
    this.active.layout()
  }

  /**
   * ⌘\: only the preview, under a slim title bar, while there's a project to show. Nothing
   * else changes, so turning it off brings back what was showing. Anything that needs the
   * chat or the toolbar (⌘J, ⇧⌘L, a pick or a permission card) turns it off first.
   */
  setFocusMode(on: boolean) {
    const focus = on && this.active.getState().project !== null
    if (focus === this.focus) return
    // The preview grows into the window, or back, as the chrome slides away or returns.
    this.active.morphLayout('focus')
    this.focus = focus
    this.syncTrafficLights()
    this.active.layout()
    this.sendState()
    // The keys go to the page, where Esc ends focus mode; the chat that had them is hidden.
    if (focus && this.win.isFocused()) this.active.focusPreview()
    windowEvents.emit('changed')
  }

  /**
   * ⌘/: the chrome's Keyboard Shortcuts sheet, over the window. The preview and the chat are
   * views on top of the chrome, so they're hidden while it's open; it has the keyboard.
   */
  setShortcutsOpen(open: boolean) {
    if (open === this.sheet) return
    this.sheet = open
    this.sendState()
    if (open) {
      // Opened again while it fades out: the views are still hidden.
      if (this.sheetLeaving) clearTimeout(this.sheetLeaving)
      this.sheetLeaving = null
      this.active.layout()
      this.win.webContents.focus()
      return
    }
    // The views come back once the sheet has faded out, rather than over it as it goes.
    this.sheetLeaving = setTimeout(() => {
      this.sheetLeaving = null
      if (!this.disposed) this.active.layout()
    }, SHEET_EXIT_MS)
  }

  // Shortcuts for the chrome's own controls (UiCommand)

  /** ⇧⌘L: the toolbar's address field, focused with its text selected. */
  focusAddress() {
    if (!this.active.getState().project) return shell.beep()
    this.setFocusMode(false)
    this.win.webContents.focus()
    this.send(Events.command, 'focusAddress')
  }

  /**
   * ⇧⌘S: the screenshot menu, under the toolbar's button, which shows what it did; in focus
   * mode, at the pointer.
   */
  screenshot() {
    if (!this.active.getState().project) return shell.beep()
    if (this.focus) void this.active.screenshotMenu()
    else this.send(Events.command, 'screenshot')
  }

  /**
   * ⌥⌘R: the toolbar's Record button, starting or stopping. Run as a user gesture, as a
   * click is: screen capture only starts from one. From Record's menu, `narrate` is the
   * choice made there (with your voice or not); ⌥⌘R starts the one chosen last.
   */
  recordPreview(narrate?: boolean) {
    const { project, preview } = this.active.getState()
    if (!project || !preview.visible || !preview.selectable || this.focus) return shell.beep()
    const detail = JSON.stringify(narrate === undefined ? null : { narrate })
    this.win.webContents
      .executeJavaScript(
        `window.dispatchEvent(new CustomEvent('gui:record', { detail: ${detail} }))`,
        true,
      )
      .catch(() => undefined)
  }

  /**
   * Edit → Find, Find Next or Find Previous (shared/find.ts): the find bar of the drawer's
   * terminal that has the keyboard, otherwise the preview's, under the toolbar. `focus` is the
   * page that had the keyboard when it was chosen.
   */
  async find(action: FindAction, focus: FindContext['focus']) {
    const inTerminal = focus === 'chrome' && (await this.terminalHasKeyboard())
    const previewShown = this.active.getState().preview.visible
    const area = findArea({ focus, inTerminal, previewShown })
    if (!area || this.disposed) return shell.beep()
    // The preview's find bar is under the toolbar, which focus mode hides.
    if (area === 'preview') this.setFocusMode(false)
    // Its field takes the keyboard. (Focusing web contents also raises its window.)
    if (action === 'show' && this.win.isFocused()) this.win.webContents.focus()
    const command: FindCommand = { action, area }
    this.send(Events.find, command)
  }

  /** Whether the keyboard is in one of the drawer's terminals, or its find bar. */
  private async terminalHasKeyboard() {
    const code = `!!document.activeElement?.closest('[data-find-scope="terminal"]')`
    try {
      return (await this.win.webContents.executeJavaScript(code)) === true
    } catch {
      return false
    }
  }

  /**
   * ⇧⌘N and ⇧⌘O: the start screen's name or repo field, in this tab if it's a start screen
   * or a new one.
   */
  showStartForm(form: StartForm) {
    if (this.active.hasProject) this.newTab()
    this.setFocusMode(false)
    focusWindow(this.win)
    const { webContents } = this.win
    webContents.focus()
    // A window just made has no page to tell yet.
    if (webContents.isLoading()) {
      webContents.once('did-finish-load', () => this.send(Events.command, form))
    } else this.send(Events.command, form)
  }

  // Tabs

  /** A start-screen tab at the end of the strip, shown. */
  newTab() {
    const tab = new ProjectTab(this)
    this.list.push(tab)
    this.showTab(tab)
    return tab
  }

  /** Whether File → Reopen Closed Tab has a tab to reopen. */
  get canReopenTab() {
    return this.closed.size > 0
  }

  /**
   * ⇧⌘T: the tab closed last, no longer remembered, with a start-screen tab where it was,
   * shown, to open its project in. Undefined when there's none to reopen.
   */
  reopenTab(): { closed: ClosedTab; tab: ProjectTab } | undefined {
    const closed = this.closed.pop()
    if (!closed) return undefined
    const tab = new ProjectTab(this)
    this.list.splice(reopenIndex(closed, this.list.length), 0, tab)
    this.showTab(tab)
    return { closed, tab }
  }

  /** Shows `tab`: its views go in the window and the chrome shows its state. */
  showTab(tab: ProjectTab) {
    if (!this.list.includes(tab)) return
    if (tab !== this.active) {
      const previous = this.active
      this.active = tab
      previous.deactivate()
      // Typing goes to the chrome, not to a chat panel that just left the window. (Focusing
      // web contents also raises its window, which a background switch mustn't.)
      if (this.win.isFocused()) this.win.webContents.focus()
      // Focus mode shows a project; a start screen needs the toolbar.
      if (!tab.getState().project) this.setFocusMode(false)
      tab.activate()
      windowEvents.emit('activeTab')
    }
    this.syncChrome()
  }

  selectTab(id: string) {
    const tab = this.byId(id)
    if (tab) this.showTab(tab)
  }

  /** The next tab, or with `step` -1 the previous one, wrapping around. */
  showAdjacentTab(step: 1 | -1) {
    const count = this.list.length
    const next = this.list[(this.list.indexOf(this.active) + step + count) % count]
    if (next) this.showTab(next)
  }

  /**
   * Closes the tab like closing a window did: its agent and dev server stop without asking.
   * The last tab closes the window.
   */
  closeTab(id: string) {
    const tab = this.byId(id)
    if (!tab) return
    if (this.list.length === 1) {
      this.win.close()
      return
    }
    this.remember(tab)
    this.remove(tab)
    tab.dispose()
    this.syncChrome()
  }

  closeOtherTabs(id: string) {
    const keep = this.byId(id)
    if (!keep) return
    this.showTab(keep)
    const others = this.list.filter((tab) => tab !== keep)
    for (const tab of others) this.remember(tab)
    this.list = [keep]
    for (const tab of others) tab.dispose()
    this.syncChrome()
  }

  /** A tab about to close, to reopen later; a start screen has nothing to reopen. */
  private remember(tab: ProjectTab) {
    const root = tab.projectRoot
    if (!root) return
    const kind = boardIdOf(root) ? 'canvas' : 'project'
    this.closed.push({ kind, root, index: this.list.indexOf(tab) })
  }

  /** Puts the tab at `index` in the strip (dragging it there). */
  moveTab(id: string, index: number) {
    const tab = this.byId(id)
    if (!tab) return
    const rest = this.list.filter((other) => other !== tab)
    rest.splice(Math.max(0, Math.min(Math.round(index), rest.length)), 0, tab)
    this.list = rest
    this.syncChrome()
  }

  /** Gives the tab a window of its own; its agent and dev server carry on. */
  moveToNewWindow(id: string) {
    const tab = this.byId(id)
    if (!tab || this.list.length < 2) return
    this.remove(tab)
    this.syncChrome()
    return new ProjectWindow(tab)
  }

  showTabMenu(id: string) {
    if (!this.byId(id)) return
    const others = this.list.length > 1
    Menu.buildFromTemplate([
      { label: 'Close Tab', click: () => this.closeTab(id) },
      { label: 'Close Other Tabs', enabled: others, click: () => this.closeOtherTabs(id) },
      { type: 'separator' },
      { label: 'Move Tab to New Window', enabled: others, click: () => this.moveToNewWindow(id) },
    ]).popup({ window: this.win })
  }

  /** Takes a tab out of the strip, showing its neighbor instead if it's the active one. */
  private remove(tab: ProjectTab) {
    const index = this.list.indexOf(tab)
    const neighbor = this.list[index + 1] ?? this.list[index - 1]
    this.list = this.list.filter((other) => other !== tab)
    if (tab === this.active && neighbor) this.showTab(neighbor)
  }

  // TabHost

  tabChanged(tab: ProjectTab, stateChanged: boolean) {
    if (this.disposed || !this.list.includes(tab)) return
    if (tab === this.active) {
      this.syncTitle()
      this.syncTrafficLights()
      windowEvents.emit('changed')
    }
    const strip = JSON.stringify(this.tabInfos())
    if ((stateChanged && tab === this.active) || strip !== this.sentTabs) this.sendState()
  }

  sendChrome(tab: ProjectTab, channel: string, payload: unknown) {
    if (tab === this.active) this.send(channel, payload)
  }

  shareRecent(recent: RecentProject[]) {
    for (const tab of allTabs()) tab.setRecent(recent)
  }

  shareBoards(boards: RecentBoard[]) {
    shareBoards(boards)
  }

  // Plumbing

  private tabInfos(): TabInfo[] {
    return this.list.map((tab) => ({ id: tab.id, title: tab.title, status: tab.status }))
  }

  /** After the tabs changed: the traffic lights, the title and the chrome's state. */
  private syncChrome() {
    if (this.disposed) return
    this.syncTrafficLights()
    this.syncTitle()
    this.sendState()
    windowEvents.emit('tabs')
  }

  /**
   * In focus mode's title bar, the tab row's height while it shows (in the tab row, or the
   * chat sidebar's header, which is then as tall), or the toolbar's.
   */
  private syncTrafficLights() {
    const tabbed = this.list.length > 1
    const lights = this.focus
      ? FOCUS_TRAFFIC_LIGHTS
      : tabbed
        ? TAB_ROW_TRAFFIC_LIGHTS
        : TRAFFIC_LIGHTS
    if (lights === this.lights) return
    this.lights = lights
    this.win.setWindowButtonPosition(lights)
  }

  /** The window is named like the active tab (its project), and is the project's proxy icon. */
  private syncTitle() {
    const title = this.active.title ?? 'Gui'
    if (this.win.getTitle() !== title) this.win.setTitle(title)
    const file = this.active.getState().project?.root ?? ''
    if (this.win.getRepresentedFilename() !== file) this.win.setRepresentedFilename(file)
  }

  private sendState() {
    const state = this.getState()
    this.sentTabs = JSON.stringify(state.tabs)
    this.send(Events.state, state)
  }

  private send(channel: string, payload: unknown) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  private byId(id: string) {
    return this.list.find((tab) => tab.id === id)
  }

  private dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.sheetLeaving) clearTimeout(this.sheetLeaving)
    windows.delete(this)
    for (const tab of this.list) tab.dispose()
  }

  /** Synchronous teardown for app quit. */
  destroy() {
    this.dispose()
  }
}
