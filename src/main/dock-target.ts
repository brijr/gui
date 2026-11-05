import { type BrowserWindow, type View, WebContentsView } from 'electron'
import { ACCENT, ACCENT_SOFT } from '../shared/theme'
import type { Rect } from '../shared/types'

/** In from the sidebar's edges, so it reads as a place to let go rather than a wall. */
const INSET = 8
/** Gone this long after it starts to fade (--motion-exit), so it stops taking the pointer. */
const EXIT_MS = 100

const rgba = ({ r, g, b, a }: { r: number; g: number; b: number; a: number }) =>
  `rgb(${r} ${g} ${b} / ${a})`

/**
 * The page: an area drawn as the pick overlay draws one (border-accent, bg-accent-soft,
 * rounded-xl), fading in over --motion-pop with --ease-out and out over --motion-exit with
 * --ease-in. Opacity only, which reduced motion keeps, as the app's cross-fades do.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><style>
:root { color-scheme: light dark; --accent: ${ACCENT.light}; --accent-soft: ${rgba(ACCENT_SOFT.light)} }
@media (prefers-color-scheme: dark) {
  :root { --accent: ${ACCENT.dark}; --accent-soft: ${rgba(ACCENT_SOFT.dark)} }
}
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; pointer-events: none }
div {
  position: fixed; inset: ${INSET}px; box-sizing: border-box; border-radius: 12px;
  border: 1px solid var(--accent); background: var(--accent-soft);
  opacity: 0; transition: opacity 100ms cubic-bezier(0.4, 0, 1, 1);
}
body.shown div { opacity: 1; transition: opacity 160ms cubic-bezier(0.2, 0, 0, 1) }
</style><body><div></div></body>`

/**
 * Where the floating chat docks if the user lets go of it here: the sidebar's place at the
 * window's edge, drawn over the preview and under the chat. It's a view of its own, because
 * the preview is a native view too and nothing the chrome draws shows over it. One per window,
 * made the first time a drag might need it so it's ready by the time the pointer reaches an
 * edge; it takes no input and holds no state.
 */
class DockTarget {
  private readonly view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, javascript: true },
  })
  private shown = false
  private hideTimer: NodeJS.Timeout | null = null

  constructor(private readonly win: BrowserWindow) {
    this.view.setBackgroundColor('#00000000')
    this.view.setVisible(false)
    const wc = this.view.webContents
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Asked to show before its page was there: it shows once it is.
    wc.on('did-finish-load', () => this.paint())
    wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => undefined)
  }

  /** Shows it over `rect` (the sidebar's place in the window), just under `chat`. */
  show(rect: Rect, chat: View) {
    if (this.win.isDestroyed()) return
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = null
    this.view.setBounds(rect)
    const { contentView } = this.win
    const children = contentView.children
    const at = children.indexOf(this.view)
    const chatAt = children.indexOf(chat)
    if (at === -1 || chatAt === -1 || at !== chatAt - 1) {
      if (at !== -1) contentView.removeChildView(this.view)
      const under = contentView.children.indexOf(chat)
      contentView.addChildView(this.view, under === -1 ? undefined : under)
    }
    this.view.setVisible(true)
    if (this.shown) return
    this.shown = true
    this.paint()
  }

  /** Fades it out; `now`, it's simply gone (the tab went, or the chat stopped floating). */
  hide(now = false) {
    if (!this.shown && !now) return
    this.shown = false
    this.paint()
    if (this.hideTimer) clearTimeout(this.hideTimer)
    const gone = () => {
      this.hideTimer = null
      if (this.shown || this.win.isDestroyed()) return
      this.view.setVisible(false)
      this.win.contentView.removeChildView(this.view)
    }
    if (now) gone()
    else this.hideTimer = setTimeout(gone, EXIT_MS)
  }

  get visible() {
    return this.shown
  }

  private paint() {
    const wc = this.view.webContents
    if (wc.isDestroyed()) return
    const code = `document.body.classList.toggle('shown', ${this.shown})`
    wc.executeJavaScript(code).catch(() => undefined)
  }

  destroy() {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }
}

const targets = new WeakMap<BrowserWindow, DockTarget>()

/** The window's dock target, made on first use and closed with the window. */
export function dockTarget(win: BrowserWindow): DockTarget {
  let target = targets.get(win)
  if (!target) {
    const made = new DockTarget(win)
    target = made
    targets.set(win, made)
    win.once('closed', () => made.destroy())
  }
  return target
}

/** The window's dock target if one was made, without making it. */
export function existingDockTarget(win: BrowserWindow) {
  return targets.get(win) ?? null
}
