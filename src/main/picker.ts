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
import type { GuideOverlay, PickOverlayState, Point, Rect, VariationsBar } from '../shared/types'
import { PANEL_MARGIN } from './chat-presentation'
import { glideMs } from './input-pace'
import type { Inspector } from './inspector'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'

/** How often what's outlined is measured again while nothing moves (animations, late layout). */
const IDLE_REFRESH_MS = 250
/** After the wheel, it's measured every frame for this long, so outlines follow the scroll. */
const SCROLL_FOLLOW_MS = 500
const FRAME_MS = 16
/** Labels kept for elements hovered recently; they're page data and cheap to ask again. */
const MAX_LABELS = 300
/** Room around the variations bar in its own overlay, for its shadow (shadow-popover) */
const BAR_MARGIN = { x: 24, top: 16, bottom: 32 }
/** The walkthrough's pointer gliding to each step's element: slow enough for the eye to follow */
const STEP_GLIDE_MS = 400
/** The variations bar floats this far in from the page's edges, as the floating chat does. */
const BAR_INSET = PANEL_MARGIN
/** The least room the bar keeps beside the chat (its name shortened) before it goes over it */
const BAR_MIN_WIDTH = 240

/** The variations bar (docs/variations.md): what it says. */
export type Bar = Omit<VariationsBar, 'at' | 'room'>

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
    /** Where the pointer is drawn: `cursor`, or the step's element; null while it isn't */
    shownAt: Point | null
    /** How long its last move takes */
    glide: number
    clicks: number
    key: GuideOverlay['key']
    step: number
  } | null = null
  /**
   * The agent's turn is using this page (a website): the walkthrough's overlay stays over it,
   * so the user's clicks don't reach the page, and a click there says why.
   */
  private held = false
  /**
   * The variations bar, at the page's bottom-left. On its own, the overlay is only as big as
   * the bar, so the page around it takes the pointer as usual.
   */
  private bar: Bar | null = null
  /** The bar's size, as the overlay last measured it */
  private barSize = { width: 360, height: 36 }
  /** The page's bounds in the window, for the bar; null while it's out of sight */
  private area: Rect | null = null
  /** The floating chat in the canvas's bottom-left corner, in the window: the bar sits right of it */
  private chat: Rect | null = null

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
      this.redraw()
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

  get holding() {
    return this.held
  }

  /** Measured and drawn while picking or guiding (the bar on its own needs no measuring). */
  private get shown() {
    return this.active || this.guided !== null
  }

  /**
   * Lays the overlay over the page and gives it the keyboard (Esc ends picking). `pointer` is
   * where the pointer already is over it, if it is.
   */
  start(bounds: Rect, pointer: Point | null) {
    // Picking is the user's: the walkthrough steps aside, and the variations bar until it ends.
    this.guided = null
    this.active = true
    this.area = bounds
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
    if (this.bar) this.drawBar()
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
      shownAt: previous?.shownAt ?? null,
      glide: STEP_GLIDE_MS,
      clicks: previous?.clicks ?? 0,
      key: previous?.key ?? null,
      step: (previous?.step ?? 0) + 1,
    }
    this.area = bounds
    this.view.setBounds(bounds)
    this.view.setVisible(true)
    this.schedule()
    return true
  }

  /**
   * The agent's pointer glides to `at` (the page's CSS pixels) from where it is, over `ms` or
   * as long as the way takes (input-pace.ts); how long that is. It fades in there when it
   * wasn't showing.
   */
  guideCursor(at: Point, ms?: number) {
    const guided = this.guided
    if (!guided) return 0
    guided.glide = ms ?? glideMs(guided.shownAt, at)
    guided.cursor = at
    guided.shownAt = at
    this.schedule()
    return guided.glide
  }

  /** The agent's pointer shows a key it pressed, where it is (if it's showing). */
  guideKey(label: string) {
    const guided = this.guided
    if (!guided) return
    guided.key = { label, presses: (guided.key?.presses ?? 0) + 1 }
    this.schedule()
  }

  /** The agent's pointer clicks where it is: its ring spreads as the real click lands. */
  guideClick() {
    const guided = this.guided
    if (!guided) return
    guided.clicks++
    this.schedule()
  }

  /** Whether the agent's turn holds the page (`held`); the caller keeps a guide shown meanwhile. */
  hold(held: boolean) {
    if (this.held === held) return
    this.held = held
    this.schedule()
  }

  endGuide() {
    if (!this.guided) return
    this.guided = null
    if (this.active) return this.schedule()
    if (this.bar) return this.drawBar()
    this.view.setVisible(false)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.send({ hover: null, picked: [], busy: false, scale: this.scale(), run: this.run })
  }

  /** The page moved or resized under the overlay. */
  setBounds(bounds: Rect) {
    if (!this.shown) return
    this.area = bounds
    this.view.setBounds(bounds)
    this.schedule()
  }

  /**
   * Shows the variations bar, or with null takes it away. Under the walkthrough it's drawn in
   * the walkthrough's overlay; while picking, not at all.
   */
  setBar(bar: Bar | null) {
    this.bar = bar
    if (this.shown) return this.schedule()
    this.drawBar()
  }

  /**
   * Where the bar goes: the page's bottom-left, over the page at `area` (null: the page is out
   * of sight, and so is the bar), right of `chat` when that's in the corner.
   */
  placeBar(area: Rect | null, chat: Rect | null) {
    this.area = area
    this.chat = chat
    if (this.bar) this.redraw()
  }

  /** The overlay measured the bar. */
  setBarSize(width: number, height: number) {
    const size = { width: Math.ceil(width), height: Math.ceil(height) }
    if (size.width === this.barSize.width && size.height === this.barSize.height) return
    this.barSize = size
    if (this.bar) this.redraw()
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

  /** The overlay's point `at` as the viewport's, in CSS pixels. */
  toPagePoint(at: Point): Point {
    return this.toPage(at)
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
    // A walkthrough click timed before the page went away finds nothing to show.
    this.guided = null
    this.bar = null
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
            variations: this.barAt(),
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
    // The next move glides from here (the overlay draws a step's pointer at its element's centre).
    if (this.guided === guided)
      guided.shownAt =
        guided.cursor ?? (box && { x: box.x + box.width / 2, y: box.y + box.height / 2 })
    return {
      rect: box && this.toView(box),
      // Once its element is gone (navigation, hot reload), the caption no longer points at it.
      caption: guided.node !== null && !box ? null : guided.caption,
      cursor,
      glide: guided.glide,
      clicks: guided.clicks,
      key: guided.key,
      step: guided.step,
      held: this.held,
    }
  }

  /**
   * The bar as an overlay over the whole page draws it: floating in the page's bottom-left
   * corner, or just right of the chat when the chat is there over it.
   */
  private barAt(): VariationsBar | null {
    const { bar, area, chat, barSize } = this
    if (!bar || !area) return null
    const top = area.height - BAR_INSET - barSize.height
    let left = BAR_INSET
    const covered =
      chat !== null &&
      chat.x < area.x + left + barSize.width &&
      chat.x + chat.width > area.x + left &&
      chat.y < area.y + top + barSize.height &&
      chat.y + chat.height > area.y + top
    // Beside the chat while there's room for it; the name shortens first.
    if (covered)
      left = Math.max(
        BAR_INSET,
        Math.min(chat.x + chat.width + BAR_INSET - area.x, area.width - BAR_INSET - BAR_MIN_WIDTH),
      )
    return { ...bar, at: { x: left, y: top }, room: area.width - left - BAR_INSET }
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

  /** Draws again: measured while picking or guiding, the bar on its own at once. */
  private redraw() {
    if (this.shown) this.schedule()
    else this.drawBar()
  }

  /**
   * The bar on its own (or nothing): the overlay is the bar, with room for its shadow, kept
   * over the page (never the chrome around it, whose clicks it would take).
   */
  private drawBar() {
    const bar = this.barAt()
    const { area } = this
    const idle = { hover: null, picked: [], busy: false, scale: this.scale(), run: this.run }
    if (!bar || !area) {
      this.view.setVisible(false)
      return this.send(idle)
    }
    const left = area.x + bar.at.x
    const top = area.y + bar.at.y
    const x = Math.max(area.x, left - BAR_MARGIN.x)
    const y = Math.max(area.y, top - BAR_MARGIN.top)
    const right = Math.min(area.x + area.width, left + this.barSize.width + BAR_MARGIN.x)
    const bottom = Math.min(area.y + area.height, top + this.barSize.height + BAR_MARGIN.bottom)
    this.view.setBounds({ x, y, width: right - x, height: bottom - y })
    this.view.setVisible(true)
    this.send({ ...idle, variations: { ...bar, at: { x: left - x, y: top - y } } })
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
