import { EventEmitter } from 'node:events'
import { BrowserWindow, Menu, shell, type WebContents } from 'electron'
import { Events } from '../shared/ipc'
import {
  FOCUS_BAR_HEIGHT,
  FOCUS_TRAFFIC_LIGHTS,
  TAB_ROW_HEIGHT,
  TAB_ROW_TRAFFIC_LIGHTS,
  TOOLBAR_HEIGHT,
  TRAFFIC_LIGHTS,
} from '../shared/layout'
import type { RecentProject, Rect, TabInfo, WindowState } from '../shared/types'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'
import { ProjectTab, type TabHost } from './tab'
import { followSurface, surfaceColor } from './theme'

const windows = new Set<ProjectWindow>()
/** The window focused last, for opening a project while Gui is in the background. */
let lastFocused: ProjectWindow | null = null

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

export function focusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  for (const win of windows) if (win.win === focused) return win
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

export function windowOf(tab: ProjectTab) {
  return allWindows().find((win) => win.tabs.includes(tab))
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
    // The title is the active tab's project, not the chrome page's own.
    this.win.on('page-title-updated', (event) => event.preventDefault())
    this.win.on('focus', () => {
      lastFocused = this
    })
    this.win.once('ready-to-show', () => this.win.show())
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
    this.active.layout()
    this.sendState()
    if (open) this.win.webContents.focus()
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

  // Tabs

  /** A start-screen tab at the end of the strip, shown. */
  newTab() {
    const tab = new ProjectTab(this)
    this.list.push(tab)
    this.showTab(tab)
    return tab
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
    this.remove(tab)
    tab.dispose()
    this.syncChrome()
  }

  closeOtherTabs(id: string) {
    const keep = this.byId(id)
    if (!keep) return
    this.showTab(keep)
    const others = this.list.filter((tab) => tab !== keep)
    this.list = [keep]
    for (const tab of others) tab.dispose()
    this.syncChrome()
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
      { label: 'Close tab', click: () => this.closeTab(id) },
      { label: 'Close other tabs', enabled: others, click: () => this.closeOtherTabs(id) },
      { type: 'separator' },
      { label: 'Move tab to new window', enabled: others, click: () => this.moveToNewWindow(id) },
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

  /** In focus mode's title bar, the tab row while it shows, or the toolbar. */
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
    windows.delete(this)
    for (const tab of this.list) tab.dispose()
  }

  /** Synchronous teardown for app quit. */
  destroy() {
    this.dispose()
  }
}
