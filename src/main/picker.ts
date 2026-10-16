import { type WebContents, WebContentsView } from 'electron'
import {
  pagePoint,
  pageRectFrom,
  viewFromViewport,
  viewPointFrom,
  viewportFromView,
  viewportPointFrom,
  viewportRectFrom,
  viewportRectFromPage,
  viewportRectFromView,
  viewRectFrom,
  viewRectFromViewport,
} from '../shared/coords'
import { Events } from '../shared/ipc'
import type { GuideOverlay, PickOverlayState, Point, Rect } from '../shared/types'
import type { Inspector } from './inspector'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'

/** How often what's outlined is measured again while nothing moves (animations, late layout). */
const IDLE_REFRESH_MS = 250
/** After the wheel, it's measured every frame for this long, so outlines follow the scroll. */
const SCROLL_FOLLOW_MS = 500
const FRAME_MS = 16
/** Labels kept for elements hovered recently; they're page data and cheap to ask again. */
const MAX_LABELS = 300

/**
 * Something picked that the overlay outlines: an element by its node, or an area of the page
 * (`fixed`: of the viewport, for one still being read).
 */
export type Outlined =
  | { id: string; kind: 'element'; node: number }
  | { id: string; kind: 'region'; area: Rect; fixed?: boolean }

/**
 * Picking in the preview. A transparent view of Gui's own lies over the page while the user
 * picks and draws there (src/renderer/src/pick): the element under the pointer, what's been
 * picked, and a dragged-out area. Its pointer and wheel come here; the elements come from the
 * protocol (the inspector), never from the page. Coordinates from and to the overlay are its
 * own, the preview view's: the page's CSS pixels times `scale`.
 */
export class Picker {
  readonly view: WebContentsView
  private active = false
  private pointer: Point | null = null
  private outlined: Outlined[] = []
  private busy = false
  private refreshing = false
  /** Something changed while a refresh ran; it runs again when that one ends. */
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private followUntil = 0
  /** The element under the pointer and its label, kept while the pointer stays on it. */
  private hovered: { node: number; label: string | null } | null = null
  private readonly labels = new Map<number, string>()
  /** What the overlay was last sent, to skip sending the same again. */
  private lastSent: string | null = null
  private run = 0
  /**
   * The agent's walkthrough (preview_point): an element and a caption, and its pointer in the
   * page's CSS pixels. Drawn over the page without the keyboard, and only while not picking.
   */
  private guided: {
    node: number | null
    caption: string | null
    cursor: Point | null
    clicks: number
    step: number
  } | null = null

  constructor(
    private readonly preview: WebContents,
    private readonly inspector: Inspector,
    private readonly scale: () => number,
  ) {
    this.view = new WebContentsView({
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    })
    this.view.setBackgroundColor('#00000000')
    this.view.setVisible(false)
    guardAppContents(this.view.webContents)
    loadRenderer(this.view.webContents, 'pick').catch((error) =>
      console.error('[gui] failed to load the pick overlay', error),
    )
    // A reloaded overlay draws from the next state; send it one now.
    this.view.webContents.on('did-finish-load', () => {
      this.lastSent = null
      this.schedule()
    })
  }

  owns(wc: WebContents) {
    return wc === this.view.webContents
  }

  get picking() {
    return this.active
  }

  get guiding() {
    return this.guided !== null
  }

  /** Measured and drawn while picking or guiding. */
  private get shown() {
    return this.active || this.guided !== null
  }

  /**
   * Lays the overlay over the page and gives it the keyboard (Esc ends picking). `pointer` is
   * where the pointer already is over it, if it is.
   */
  start(bounds: Rect, pointer: Point | null) {
    // Picking is the user's: the walkthrough steps aside.
    this.guided = null
    this.active = true
    this.run++
    this.pointer = pointer
    this.view.setBounds(bounds)
    this.view.setVisible(true)
    this.view.webContents.focus()
    this.schedule()
  }

  stop() {
    this.active = false
    this.pointer = null
    this.hovered = null
    this.busy = false
    this.view.setVisible(false)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.labels.clear()
    this.send({ hover: null, picked: [], busy: false, scale: this.scale(), run: this.run })
  }

  /**
   * A step of the agent's walkthrough: points at `node` (null: none) with `caption`, over the
   * page at `bounds`. Leaves the keyboard where it is. Not while the user is picking.
   */
  guide(bounds: Rect, node: number | null, caption: string | null) {
    if (this.active) return false
    const previous = this.guided
    this.guided = {
      node,
      caption,
      // Each step's pointer goes to its element, until an input takes it elsewhere.
      cursor: null,
      clicks: previous?.clicks ?? 0,
      step: (previous?.step ?? 0) + 1,
    }
    this.view.setBounds(bounds)
    this.view.setVisible(true)
    this.schedule()
    return true
  }

  /** The agent's pointer goes to `at` (the page's CSS pixels), clicking there with `click`. */
  guideCursor(at: Point, click: boolean) {
    const guided = this.guided
    if (!guided) return
    guided.cursor = at
    if (click) guided.clicks++
    this.schedule()
  }

  endGuide() {
    if (!this.guided) return
    this.guided = null
    if (this.active) return this.schedule()
    this.view.setVisible(false)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.send({ hover: null, picked: [], busy: false, scale: this.scale(), run: this.run })
  }

  /** The page moved or resized under the overlay. */
  setBounds(bounds: Rect) {
    if (!this.shown) return
    this.view.setBounds(bounds)
    this.schedule()
  }

  /** What's picked so far, outlined while picking. */
  setOutlined(outlined: Outlined[]) {
    this.outlined = outlined
    this.schedule()
  }

  /** A pick is being read: clicks wait for it, and the overlay says so. */
  setBusy(busy: boolean) {
    this.busy = busy
    this.schedule()
  }

  hover(at: Point | null) {
    this.pointer = at
    if (!at) this.hovered = null
    this.schedule()
  }

  /** The element at `at`, in the overlay's coordinates, to pick. */
  nodeAt(at: Point) {
    return this.inspector.nodeAt(this.toPage(at))
  }

  /** The overlay's `rect` as the viewport's, in CSS pixels. */
  toPageRect(rect: Rect): Rect {
    const page = viewportRectFromView(viewRectFrom(rect), this.scale())
    return { x: page.x, y: page.y, width: page.width, height: page.height }
  }

  /**
   * Scrolls the page under the overlay as the wheel would have. Trackpads send precise,
   * pixel deltas; the page gets them as such, so it scrolls as smoothly as it would directly.
   */
  wheel(at: Point, deltaX: number, deltaY: number) {
    // Chromium's wheel deltas point the way the content moves, the DOM's the way it scrolls.
    this.preview.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(at.x),
      y: Math.round(at.y),
      deltaX: -deltaX,
      deltaY: -deltaY,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
    })
    this.pointer = at
    this.followUntil = Date.now() + SCROLL_FOLLOW_MS
    this.schedule()
  }

  dispose() {
    this.stop()
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }

  private toPage(at: Point): Point {
    const point = viewportFromView(viewPointFrom(at), this.scale())
    return { x: point.x, y: point.y }
  }

  private toView(rect: Rect): Rect {
    const view = viewRectFromViewport(viewportRectFrom(rect), this.scale())
    return { x: view.x, y: view.y, width: view.width, height: view.height }
  }

  /** Measures again soon: now, unless a measure is running (then right after it). */
  private schedule() {
    if (!this.shown) return
    if (this.refreshing) {
      this.dirty = true
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), 0)
  }

  private async refresh() {
    this.timer = null
    if (!this.shown) return
    this.refreshing = true
    this.dirty = false
    try {
      if (this.active) {
        const [hover, picked] = await Promise.all([this.measureHover(), this.measureOutlined()])
        if (this.active)
          this.send({ hover, picked, busy: this.busy, scale: this.scale(), run: this.run })
      } else {
        const guide = await this.measureGuide()
        if (guide && this.guided)
          this.send({
            hover: null,
            picked: [],
            busy: false,
            scale: this.scale(),
            run: this.run,
            guide,
          })
      }
    } catch {
      // The page is navigating or gone; the next refresh tries again.
    } finally {
      this.refreshing = false
    }
    if (!this.shown) return
    const following = Date.now() < this.followUntil
    const delay = this.dirty ? 0 : following ? FRAME_MS : IDLE_REFRESH_MS
    this.timer = setTimeout(() => void this.refresh(), delay)
  }

  private async measureHover(): Promise<PickOverlayState['hover']> {
    const pointer = this.pointer
    if (!pointer) return null
    const node = await this.inspector.nodeAt(this.toPage(pointer))
    if (node === null) {
      this.hovered = null
      return null
    }
    const box = await this.inspector.box(node)
    if (!box) return null
    if (this.hovered?.node !== node) {
      this.hovered = { node, label: this.labels.get(node) ?? null }
      if (this.hovered.label === null) void this.fetchLabel(node)
    }
    return {
      rect: this.toView(box),
      name: this.hovered.label ?? '',
      size: `${Math.round(box.width)} × ${Math.round(box.height)}`,
    }
  }

  /** Labels arrive after the outline, so the outline never waits on page JavaScript. */
  private async fetchLabel(node: number) {
    const label = await this.inspector.label(node).catch(() => null)
    if (label === null) return
    if (this.labels.size >= MAX_LABELS) this.labels.clear()
    this.labels.set(node, label)
    if (this.hovered?.node === node) {
      this.hovered.label = label
      this.schedule()
    }
  }

  private async measureGuide(): Promise<GuideOverlay | null> {
    const guided = this.guided
    if (!guided) return null
    const box = guided.node === null ? null : await this.inspector.box(guided.node)
    const scale = this.scale()
    const cursor = guided.cursor && viewFromViewport(viewportPointFrom(guided.cursor), scale)
    return {
      rect: box && this.toView(box),
      // Once its element is gone (navigation, hot reload), the caption no longer points at it.
      caption: guided.node !== null && !box ? null : guided.caption,
      cursor,
      clicks: guided.clicks,
      step: guided.step,
    }
  }

  private async measureOutlined(): Promise<PickOverlayState['picked']> {
    if (this.outlined.length === 0) return []
    const regions = this.outlined.some((picked) => picked.kind === 'region' && !picked.fixed)
    const scroll = regions ? await this.inspector.scroll() : { x: 0, y: 0 }
    const boxes = await Promise.all(
      this.outlined.map(async (picked) => {
        if (picked.kind === 'region') {
          const { area } = picked
          if (picked.fixed) return area
          const viewport = viewportRectFromPage(pageRectFrom(area), pagePoint(scroll.x, scroll.y))
          return { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height }
        }
        return this.inspector.box(picked.node)
      }),
    )
    return this.outlined.flatMap((picked, i) => {
      const box = boxes[i]
      return box ? [{ id: picked.id, kind: picked.kind, rect: this.toView(box) }] : []
    })
  }

  private send(state: PickOverlayState) {
    if (this.view.webContents.isDestroyed()) return
    // The same picture again draws nothing new; most idle refreshes are that.
    const json = JSON.stringify(state)
    if (json === this.lastSent) return
    this.lastSent = json
    this.view.webContents.send(Events.pickState, state)
  }
}
