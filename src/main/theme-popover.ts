import { type View, type WebContents, WebContentsView } from 'electron'
import { Events } from '../shared/ipc'
import type { Point, Rect, ThemePanelState } from '../shared/types'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'

/** Room around the panel in its view, for its shadow (shadow-popover). */
const MARGIN = 12
/** The panel itself (the approved mockup); it scrolls inside when its rows don't fit. */
const PANEL = { width: 260, height: 520 }

/**
 * The Theme popover (src/renderer/src/theme): its own view over the preview, since the
 * toolbar's page can't draw there. It lies just under the chat, is only as big as the panel
 * (so the page around it keeps its clicks), stays where the user drags it, and its page is
 * only loaded while it's open.
 */
export class ThemePopover {
  private view: WebContentsView | null = null
  private host: View | null = null
  /** The view's top-left in the window */
  private at: Point = { x: 0, y: 0 }
  /** Where it may go in the window: the canvas; null while it's out of sight */
  private area: Rect | null = null
  private state: ThemePanelState | null = null

  /** `chat`: the view it stays under, when it's in the same window. */
  constructor(private readonly chat: () => View) {}

  get isOpen() {
    return this.view !== null
  }

  owns(wc: WebContents) {
    return wc === this.view?.webContents
  }

  /**
   * Opens with the panel's top-right corner at `anchor` (under the toolbar's button), or the
   * area's top-right without one.
   */
  open(anchor: Point | null, area: Rect) {
    if (this.view) return
    const view = new WebContentsView({
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    })
    view.setBackgroundColor('#00000000')
    guardAppContents(view.webContents)
    // A reloaded page draws from the state it's sent.
    view.webContents.on('did-finish-load', () => this.send())
    loadRenderer(view.webContents, 'theme').catch((error) =>
      console.error('[gui] failed to load the theme popover', error),
    )
    this.view = view
    const right = anchor?.x ?? area.x + area.width - MARGIN
    const top = anchor?.y ?? area.y
    this.at = { x: right - PANEL.width - MARGIN, y: top - MARGIN }
    this.area = area
    this.layout()
  }

  /** Gives it the keyboard: its search, and Esc to close. */
  focus() {
    this.view?.webContents.focus()
  }

  close() {
    const view = this.view
    if (!view) return
    this.view = null
    this.state = null
    this.host?.removeChildView(view)
    this.host = null
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /** Where it can be: in `host` (the window's content view; null: the tab left it), over `area`. */
  place(host: View | null, area: Rect | null) {
    this.area = area
    if (!this.view) return
    if (host !== this.host) {
      this.host?.removeChildView(this.view)
      this.host = host
      if (host) {
        // Over the preview and its overlays, under the chat.
        const chat = host.children.indexOf(this.chat())
        host.addChildView(this.view, chat === -1 ? undefined : chat)
      }
    }
    this.layout()
  }

  /** Dragged by its header, by `dx`, `dy` (screen pixels, the window's too). */
  drag(dx: number, dy: number) {
    this.at = { x: this.at.x + dx, y: this.at.y + dy }
    this.layout()
  }

  update(state: ThemePanelState) {
    this.state = state
    this.send()
  }

  dispose() {
    this.close()
  }

  /** Kept over the area: the panel may go up to its shadow past the edges, never further. */
  private layout() {
    const { view, area } = this
    if (!view) return
    if (!area || area.width <= 0 || area.height <= 0) return view.setVisible(false)
    const width = PANEL.width + MARGIN * 2
    const height = Math.min(PANEL.height, Math.max(0, area.height - MARGIN)) + MARGIN * 2
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi))
    this.at = {
      x: Math.round(clamp(this.at.x, area.x - MARGIN, area.x + area.width - width + MARGIN)),
      y: Math.round(clamp(this.at.y, area.y - MARGIN, area.y + area.height - height + MARGIN)),
    }
    view.setBounds({ ...this.at, width, height })
    view.setVisible(true)
  }

  private send() {
    const wc = this.view?.webContents
    if (this.state && wc && !wc.isDestroyed()) wc.send(Events.themeState, this.state)
  }
}
