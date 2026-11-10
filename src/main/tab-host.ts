import type { BrowserWindow } from 'electron'
import type { RecentBoard, RecentProject, Rect, WindowState } from '../shared/types'

export type TabState = Omit<
  WindowState,
  'tabs' | 'activeTab' | 'focusMode' | 'shortcutsOpen' | 'fullScreen' | 'devBoardWebgl'
>

/** The window a tab is in (window.ts), as the tab sees it. */
export interface TabHost {
  readonly win: BrowserWindow
  /** Where the chrome renderer's canvas is, which the active tab lays out over. */
  readonly canvas: Rect
  /** The window's chrome above the canvas: the toolbar, and the tab row while it shows. */
  readonly chromeHeight: number
  /** Focus mode: the preview alone, without the chat (WindowState.focusMode). */
  readonly focusMode: boolean
  /**
   * The chrome's shortcuts sheet is over the window, open or still fading out, where the tab's
   * views would hide it.
   */
  readonly sheetShown: boolean
  setFocusMode(on: boolean): void
  /** The tab whose views are in the window; only it lays out and talks to the chrome. */
  isActive(tab: { readonly id: string }): boolean
  /** The tab's state changed (`stateChanged`), or only what its tab in the strip shows. */
  tabChanged(tab: { readonly id: string }, stateChanged: boolean): void
  /** Main → the chrome renderer, dropped unless `tab` is the active tab. */
  sendChrome(tab: { readonly id: string }, channel: string, payload: unknown): void
  /** A project was added to the recent list: every tab's project menu lists it. */
  shareRecent(recent: RecentProject[]): void
  /** The canvases changed (one made, renamed or deleted): every start screen lists them. */
  shareBoards(boards: RecentBoard[]): void
}
