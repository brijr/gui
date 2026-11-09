import { nativeTheme, type View, type WebContents, WebContentsView } from 'electron'
import {
  pageFromViewport,
  pagePoint,
  viewFromViewport,
  viewPoint,
  viewportFromPage,
  viewportFromView,
} from '../shared/coords'
import { Events, type GuidePointerPhase } from '../shared/ipc'
import { ACCENT } from '../shared/theme'
import type { GuideStrips, Point, Rect, RulerGuide, RulersView } from '../shared/types'
import type { Inspector } from './inspector'
import { getPrefs, MAX_GUIDES, prefsEvents, setPrefs } from './prefs'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'

/** A guide's grab strip across the page, in the view's pixels; its line is the middle one. */
const STRIP = 7
const HALF = (STRIP - 1) / 2
/** A dragged guide snaps to an edge of the element under the pointer this close (view pixels). */
const SNAP = 5
/** A press on a guide that moves less than this (view pixels) leaves it where it was. */
const DRAG_THRESHOLD = 2
/** The strip that shows where a dragged guide goes. */
const DRAG_ID = 'drag'

type Axis = RulerGuide['axis']

interface Guide extends RulerGuide {
  id: string
}

interface Drag {
  /** The guide being moved; null for one coming out of a ruler */
  id: string | null
  axis: Axis
  /** Where it goes, in page pixels; null until the pointer has moved */
  at: number | null
  /** Over its ruler: letting go deletes it */
  removing: boolean
  /** The strip pressed, in the view's pixels: the pointer's own coordinates are its */
  origin: Point
  /** Where a guide was pressed; null for one out of a ruler */
  start: Point | null
  moved: boolean
  /** The latest pointer not yet placed (it's placed after the snap before it) */
  next: Point | null
  run: Promise<void>
}

export interface GuidesHost {
  inspector: Inspector
  /** The preview view's pixels per page CSS pixel */
  scale: () => number
  /** The open project's root; guides are kept per project */
  root: () => string | null
  sendChrome: (channel: string, payload: unknown) => void
  /** The rulers came or went: the page moves over for them, or back */
  relayout: () => void
}

/**
 * Rulers and guides over the preview (⇧R), like Figma's. The chrome draws the rulers beside
 * the page (app/rulers.tsx); main keeps the guides, in page CSS pixels, per project in prefs.
 *
 * Each guide is drawn over the page by a thin strip view of its own, 7px across with the line
 * in its middle, so the page around it keeps the pointer (a view can't let clicks through).
 * The strips are windows the guides overlay page opens (src/renderer/src/guides-main.ts), so
 * they all share its one renderer process. Nothing is drawn in the page: guides stay out of
 * its DOM, screenshots, captures and recordings, which all read the preview's own frames.
 */
export class Guides {
  private shown = getPrefs().rulers
  private root: string | null = null
  private guides: Guide[] = []
  private nextId = 1
  private scroll: Point = { x: 0, y: 0 }
  /** The page in the window; null while it's out of sight (or not the app's page) */
  private bounds: Rect | null = null
  private canvas: Rect = { x: 0, y: 0, width: 0, height: 0 }
  /** The window's content view while the tab is in it */
  private host: View | null = null
  /** The guides overlay page, which opens the strips; not in the window itself */
  private overlay: WebContentsView | null = null
  private readonly strips = new Map<string, WebContentsView>()
  private hover: string | null = null
  private drag: Drag | null = null
  private disposed = false

  constructor(
    /** The preview view: the strips lie just above it */
    private readonly anchor: View,
    private readonly deps: GuidesHost,
  ) {
    prefsEvents.on('change', this.onPrefs)
    nativeTheme.on('updated', this.onTheme)
  }

  /** The rulers are on (⇧R), whether or not the page is on screen to show them. */
  get on() {
    return this.shown
  }

  /** Whether `wc` is the overlay page, whose messages are this tab's. */
  owns(wc: WebContents) {
    return wc === this.overlay?.webContents
  }

  /**
   * Where the page is now: `bounds` in the window (null: not on screen), the canvas it's in,
   * the window's content view while the tab is in it. The tab calls this as it lays out.
   */
  place(host: View | null, bounds: Rect | null, canvas: Rect) {
    this.loadProject()
    if (host !== this.host) {
      this.unmount()
      this.host = host
      for (const strip of this.strips.values()) this.mount(strip)
    }
    this.bounds = bounds
    this.canvas = canvas
    if (!bounds) this.endDrag(null)
    this.syncStrips()
    this.sendRulers()
  }

  /** The page scrolled (its preload says); its guides move with its content. */
  setScroll(x: number, y: number) {
    if (this.scroll.x === x && this.scroll.y === y) return
    this.scroll = { x, y }
    if (!this.shown || !this.bounds) return
    this.layoutStrips()
    this.sendRulers()
  }

  /** A guide dragged out of the chrome's ruler, `at` in the preview view's coordinates. */
  rulerDrag(axis: Axis, phase: 'move' | 'end' | 'cancel', at: Point) {
    if (!this.shown || !this.bounds) return
    if (phase === 'cancel') return this.endDrag(null)
    if (!this.drag)
      this.startDrag({ id: null, axis, at: null, origin: { x: 0, y: 0 }, start: null })
    if (this.drag?.id !== null || this.drag.axis !== axis) return
    if (phase === 'end') this.endDrag(at)
    else this.moveDrag(at)
  }

  /** The pointer on a guide's strip, `at` in the strip's coordinates. */
  stripPointer(id: string, phase: GuidePointerPhase, at: Point) {
    const guide = this.guides.find((each) => each.id === id)
    const strip = this.strips.get(id)
    if (!guide || !strip || !this.bounds) return
    if (phase === 'enter' || phase === 'leave') {
      const hover = phase === 'enter' ? id : this.hover === id ? null : this.hover
      if (hover === this.hover) return
      this.hover = hover
      return this.sendRulers()
    }
    if (phase === 'down') {
      if (this.drag) return
      const box = strip.getBounds()
      const origin = { x: box.x - this.bounds.x, y: box.y - this.bounds.y }
      const start = { x: origin.x + at.x, y: origin.y + at.y }
      this.startDrag({ id, axis: guide.axis, at: guide.at, origin, start })
      return
    }
    const drag = this.drag
    if (drag?.id !== id) return
    const point = { x: drag.origin.x + at.x, y: drag.origin.y + at.y }
    if (phase === 'move') this.moveDrag(point)
    else if (phase === 'up') this.endDrag(point)
    else this.endDrag(null)
  }

  /** Takes the strips out of the window (the tab leaves it). */
  unmount() {
    const host = this.host
    if (!host) return
    for (const strip of this.strips.values()) host.removeChildView(strip)
    this.host = null
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    prefsEvents.off('change', this.onPrefs)
    nativeTheme.off('updated', this.onTheme)
    this.drag = null
    this.unmount()
    for (const strip of this.strips.values()) closeContents(strip.webContents)
    this.strips.clear()
    if (this.overlay) closeContents(this.overlay.webContents)
    this.overlay = null
  }

  private onPrefs = () => {
    const { rulers } = getPrefs()
    if (rulers === this.shown) return
    this.shown = rulers
    this.hover = null
    this.endDrag(null)
    this.deps.relayout()
  }

  private onTheme = () => this.sendStrips()

  /** The project's guides, read again when another project opens in the tab. */
  private loadProject() {
    const root = this.deps.root()
    if (root === this.root) return
    this.root = root
    this.drag = null
    this.hover = null
    this.scroll = { x: 0, y: 0 }
    const saved = root ? (getPrefs().guides[root] ?? []) : []
    this.guides = saved.map((guide) => ({ ...guide, id: String(this.nextId++) }))
  }

  private save() {
    const root = this.root
    if (!root) return
    const { [root]: _old, ...others } = getPrefs().guides
    const guides = this.guides.map(({ axis, at }) => ({ axis, at }))
    setPrefs({ guides: guides.length ? { ...others, [root]: guides } : others })
  }

  private startDrag(drag: Pick<Drag, 'id' | 'axis' | 'at' | 'origin' | 'start'>) {
    this.drag = { ...drag, removing: false, moved: false, next: null, run: Promise.resolve() }
    this.syncStrips()
  }

  /** Places the dragged guide at the pointer, once the snap before has been placed. */
  private moveDrag(at: Point) {
    const drag = this.drag
    if (!drag) return
    drag.next = at
    drag.run = drag.run.then(() => this.step(drag))
  }

  private async step(drag: Drag) {
    const at = drag.next
    if (!at || this.drag !== drag) return
    drag.next = null
    // Out of a ruler, any move is a drag; a guide pressed stays put until it's really moved.
    if (!drag.moved) {
      const { start } = drag
      drag.moved = start === null || Math.abs(at[drag.axis] - start[drag.axis]) >= DRAG_THRESHOLD
      if (!drag.moved) return
    }
    const placed = await this.position(drag.axis, at)
    if (this.drag !== drag) return
    drag.at = placed.at
    drag.removing = placed.removing
    this.layoutStrips()
    this.sendRulers()
  }

  /** Lets go of the dragged guide at `at` (null: Esc, or the drag was lost), after its last move. */
  private endDrag(at: Point | null) {
    const drag = this.drag
    if (!drag) return
    if (at) this.moveDrag(at)
    else drag.next = null
    void drag.run.then(() => {
      if (this.drag !== drag) return
      this.drag = null
      if (at && drag.moved && drag.at !== null) this.commit(drag, drag.at)
      this.syncStrips()
      this.sendRulers()
    })
  }

  private commit(drag: Drag, at: number) {
    if (drag.removing) {
      if (drag.id === null) return
      this.guides = this.guides.filter((guide) => guide.id !== drag.id)
      if (this.hover === drag.id) this.hover = null
    } else if (drag.id !== null) {
      this.guides = this.guides.map((guide) => (guide.id === drag.id ? { ...guide, at } : guide))
    } else {
      if (this.guides.length >= MAX_GUIDES) return
      this.guides = [...this.guides, { id: String(this.nextId++), axis: drag.axis, at }]
    }
    this.save()
  }

  /**
   * Where a guide dragged to `at` (the view's coordinates) goes, in page pixels: snapped to the
   * nearest edge or middle of the element under the pointer when one is close; `removing` when
   * the pointer is over its ruler, left of or above the page.
   */
  private async position(axis: Axis, at: Point): Promise<{ at: number; removing: boolean }> {
    const scale = this.deps.scale()
    const viewport = viewportFromView(viewPoint(at.x, at.y), scale)
    const scroll = pagePoint(this.scroll.x, this.scroll.y)
    const raw = pageFromViewport(viewport, scroll)[axis]
    const removing = at[axis] < 0
    const bounds = this.bounds
    const inside =
      bounds !== null && at.x >= 0 && at.y >= 0 && at.x < bounds.width && at.y < bounds.height
    if (removing || !inside) return { at: Math.round(raw), removing }
    const box = await this.deps.inspector
      .nodeAt(viewport)
      .then((node) => (node === null ? null : this.deps.inspector.box(node)))
      .catch(() => null)
    if (!box) return { at: Math.round(raw), removing }
    const start = axis === 'x' ? box.x + scroll.x : box.y + scroll.y
    const size = axis === 'x' ? box.width : box.height
    const reach = SNAP / scale
    const edges = [start, start + size / 2, start + size]
      .map((edge) => ({ edge, off: Math.abs(edge - raw) }))
      .filter(({ off }) => off <= reach)
      .sort((a, b) => a.off - b.off)
    return { at: Math.round(edges[0]?.edge ?? raw), removing }
  }

  /**
   * The strips wanted while the rulers show: one per guide, and one kept ready for a guide
   * being dragged.
   */
  private wanted(): GuideStrips['strips'] {
    // Kept while the page is briefly out of sight (a morph, a sheet), only hidden.
    if (!this.shown) return []
    const strips = this.guides.map(({ id, axis }) => ({ id, axis }))
    return [...strips, { id: DRAG_ID, axis: this.drag?.axis ?? 'y' }]
  }

  private syncStrips() {
    const wanted = new Set(this.wanted().map(({ id }) => id))
    for (const [id, strip] of this.strips) {
      if (wanted.has(id)) continue
      this.strips.delete(id)
      this.host?.removeChildView(strip)
      closeContents(strip.webContents)
    }
    if (wanted.size) this.ensureOverlay()
    else if (this.overlay) {
      // Rulers off: its process goes too, until they're on again.
      closeContents(this.overlay.webContents)
      this.overlay = null
    }
    this.layoutStrips()
    this.sendStrips()
  }

  /** Puts each strip on its guide's line; out of sight when the line is off the page. */
  private layoutStrips() {
    const bounds = this.bounds
    for (const [id, strip] of this.strips) {
      const guide =
        id === DRAG_ID
          ? this.drag && this.drag.at !== null && !this.drag.removing
            ? { axis: this.drag.axis, at: this.drag.at }
            : null
          : this.guides.find((each) => each.id === id)
      const rect = guide && bounds && this.stripRect(guide, bounds)
      if (rect) strip.setBounds(rect)
      strip.setVisible(rect !== null && rect !== undefined && this.shown)
    }
  }

  /** A guide's strip in the window, or null when its line is off the page. */
  private stripRect({ axis, at }: RulerGuide, bounds: Rect): Rect | null {
    const scale = this.deps.scale()
    const scroll = pagePoint(this.scroll.x, this.scroll.y)
    const onPage = axis === 'x' ? pagePoint(at, scroll.y) : pagePoint(scroll.x, at)
    const view = viewFromViewport(viewportFromPage(onPage, scroll), scale)
    const offset = view[axis]
    const length = axis === 'x' ? bounds.width : bounds.height
    if (offset < 0 || offset >= length) return null
    const line = Math.floor(offset)
    return axis === 'x'
      ? { x: bounds.x + line - HALF, y: bounds.y, width: STRIP, height: bounds.height }
      : { x: bounds.x, y: bounds.y + line - HALF, width: bounds.width, height: STRIP }
  }

  private ensureOverlay() {
    if (this.overlay || this.disposed) return
    const overlay = new WebContentsView({
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    })
    const wc = overlay.webContents
    guardAppContents(wc)
    // Its strips: about:blank windows it opens by name ("guide:<id>:<n>"), each in a view of its
    // own over the page, in its process.
    wc.setWindowOpenHandler(({ url, frameName }) => {
      const id = /^guide:([^:]+):/.exec(frameName)?.[1]
      const blank = url === '' || url === 'about:blank'
      const wanted = this.wanted().some((strip) => strip.id === id)
      if (!id || !blank || this.strips.has(id) || !wanted) return { action: 'deny' }
      return {
        action: 'allow',
        // Electron passes the new window's contents along with its options.
        createWindow: (options) =>
          this.addStrip(id, (options as { webContents: WebContents }).webContents),
      }
    })
    wc.on('did-finish-load', () => this.sendStrips())
    this.overlay = overlay
    loadRenderer(wc, 'guides').catch((error) =>
      console.error('[gui] failed to load the guides overlay', error),
    )
  }

  private addStrip(id: string, contents: WebContents) {
    const strip = new WebContentsView({ webContents: contents })
    strip.setBackgroundColor('#00000000')
    strip.setVisible(false)
    guardAppContents(strip.webContents)
    this.strips.set(id, strip)
    this.mount(strip)
    this.layoutStrips()
    return strip.webContents
  }

  /** Just above the preview: under the pick overlay, the website and the chat. */
  private mount(strip: WebContentsView) {
    const host = this.host
    if (!host) return
    const index = host.children.indexOf(this.anchor)
    if (index === -1) return
    host.addChildView(strip, index + 1)
  }

  private sendStrips() {
    const wc = this.overlay?.webContents
    if (!wc || wc.isDestroyed()) return
    const state: GuideStrips = {
      strips: this.wanted(),
      dragging: this.drag?.id ?? null,
      color: nativeTheme.shouldUseDarkColors ? ACCENT.dark : ACCENT.light,
    }
    wc.send(Events.guideStrips, state)
  }

  private rulersView(): RulersView | null {
    const bounds = this.bounds
    if (!this.shown || !bounds) return null
    const drag = this.drag
    const hovered = this.guides.find((guide) => guide.id === this.hover)
    const active =
      drag && drag.at !== null
        ? { axis: drag.axis, at: drag.at, removing: drag.removing }
        : !drag && hovered
          ? { axis: hovered.axis, at: hovered.at, removing: false }
          : null
    return {
      page: {
        x: bounds.x - this.canvas.x,
        y: bounds.y - this.canvas.y,
        width: bounds.width,
        height: bounds.height,
      },
      scale: this.deps.scale(),
      scroll: { ...this.scroll },
      guides: this.guides.map(({ axis, at }) => ({ axis, at })),
      active,
    }
  }

  private sendRulers() {
    this.deps.sendChrome(Events.rulers, this.rulersView())
  }
}

function closeContents(wc: WebContents) {
  if (!wc.isDestroyed()) wc.close()
}
