import { performance } from 'node:perf_hooks'
import { app, type BrowserWindow, type NativeImage, screen, type WebContentsView } from 'electron'
import type { MorphEvent, MorphKind, MorphPlacement, Rect } from '../shared/types'
import { prefersReducedMotion } from './panel-flight'

/*
 * A change that moves or resizes the preview (another viewport, a zoom step, the drawer, the
 * docked chat, focus mode) morphs into its new layout: snapshot, morph, swap. Resizing the live
 * page every frame would make the user's app lay itself out again, and flip its media queries,
 * on every frame, so the chrome animates a picture of it instead (renderer app/layout-morph.ts):
 *
 * 1. Before the change, the preview is captured where it is and frozen there.
 * 2. The chrome draws the snapshot over the canvas, under the view, and says once it's on screen.
 * 3. The view goes out of sight, already at its new layout, and the chrome springs the snapshot
 *    to the new place. The view is captured again there, and the chrome cross-fades into that.
 * 4. Once the snapshot rests on its target, the live view comes back over it, and the snapshot
 *    goes as soon as the view has drawn a frame.
 *
 * A change mid-morph retargets it from wherever the snapshot is; nothing is captured again.
 *
 * "Out of sight" isn't hidden: a hidden view's page is `document.hidden`, stops drawing, and
 * only lays out at a new size once it's shown, so the user's app would see visibility events and
 * the live view would come back with a stale frame. Instead the view keeps its new size and goes
 * to the window's bottom-left corner, leaving one pixel inside it, under the window's rounded
 * corner: Chromium keeps drawing it there, so it can be captured at its new layout and shows its
 * current frame the moment it's back. Keystrokes still go to the page throughout.
 */

/** Longer than this to capture the preview, and the change is simply instant. */
const CAPTURE_BUDGET_MS = 40
/** The chrome normally has the snapshot on screen in a frame or two. */
const SHOWN_TIMEOUT_MS = 300
/** Past the last target, a morph the chrome never reported landing ends anyway. */
const LAND_TIMEOUT_MS = 1500
/** A page too busy to draw a frame in this long is taken as having drawn one. */
const PAINT_TIMEOUT_MS = 150
/** Captures that come back at another size (a page still resizing) are taken again, up to this. */
const AFTER_ATTEMPTS = 3
const JPEG_QUALITY = 85
/** The isolated world in the preview's page that waits for its frames; page scripts can't see it. */
const PAINT_WORLD = 1002
const NEXT_FRAME =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

/** How long snapshots took, for the end-to-end tests to report (unpackaged builds only). */
export interface MorphTiming {
  /** `capturePage` alone, in ms */
  capture: number
  /** From asking to having it, the inspector's lock included */
  wait: number
  /** The JPEG the chrome draws */
  encode: number
}
interface TimingStore {
  guiMorphTimings?: MorphTiming[]
}
const timings: MorphTiming[] = []
if (!app.isPackaged) (globalThis as TimingStore).guiMorphTimings = timings

/** Unique across tabs, so the chrome never takes one tab's morph for another's. */
let lastId = 0

type Phase = 'idle' | 'capturing' | 'showing' | 'moving' | 'ending'

/** A morph event without its id, which `PreviewMorph.send` adds. */
type Unnumbered<E> = E extends MorphEvent ? Omit<E, 'id'> : never

/** The tab (tab.ts) whose preview morphs. */
export interface MorphHost {
  /** The window the tab is in now (a tab can move to another) */
  window(): BrowserWindow
  readonly view: WebContentsView
  /** Runs `fn` alone among picks, agent screenshots and emulation changes (the inspector's lock) */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  /** To the window's chrome, while the tab is the one it shows */
  send(event: MorphEvent): void
  /** Lays the tab out again, which places the view through `place` */
  layout(): void
}

export class PreviewMorph {
  private phase: Phase = 'idle'
  private id = 0
  private kind: MorphKind = 'viewport'
  /** Numbers the targets sent for the morph; the chrome lands on the last one. */
  private seq = 0
  private reduced = false
  /** Where the view is on screen: the layout it was last placed at, outside a morph. */
  private onScreen: MorphPlacement | null = null
  /** Where the snapshot was taken, and where it's going. */
  private from: MorphPlacement | null = null
  private target: MorphPlacement | null = null
  /** Lets go of the inspector's lock, held from the capture until the view is out of sight. */
  private release: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly host: MorphHost) {}

  /** Between the capture and the view going out of sight: the view stays where it is. */
  get frozen() {
    return this.phase === 'capturing' || this.phase === 'showing'
  }

  /**
   * Before a change that moves or resizes the preview. Out of a morph, and `eligible` (the
   * preview on screen, nothing being picked), it captures the preview and freezes it where it
   * is; mid-morph, the change only retargets it.
   */
  request(kind: MorphKind, eligible: boolean) {
    if (this.phase === 'ending') this.end()
    if (this.phase !== 'idle') {
      this.kind = kind
      return
    }
    const from = this.onScreen
    if (!eligible || !from || from.rect.width < 1 || from.rect.height < 1) return
    this.id = ++lastId
    this.kind = kind
    this.seq = 0
    this.from = from
    this.target = null
    this.phase = 'capturing'
    // First, so the chrome holds the drawer or the toolbar for the morph when the change arrives.
    this.host.send({ type: 'pending', id: this.id, kind })
    void this.capture(this.id, from)
  }

  /**
   * Where the view goes for the layout `wanted`, or null to leave it where it is (frozen).
   * Mid-morph it's out of sight at its new size, and a new layout retargets the morph.
   */
  place(wanted: MorphPlacement, contentHeight: number): Rect | null {
    switch (this.phase) {
      case 'capturing':
      case 'showing':
        return null
      case 'moving':
        if (!this.target || !samePlacement(this.target, wanted)) this.retarget(wanted)
        return outOfSight(wanted.rect, contentHeight)
      default:
        this.onScreen = wanted
        return wanted.rect
    }
  }

  /**
   * The chrome has the snapshot on screen: the view goes out of sight at its new layout, and
   * the snapshot springs there. With Reduce motion on, the live view is simply there, and the
   * snapshot fades out where it isn't. False when `id` isn't this morph's.
   */
  snapshotShown(id: number) {
    if (id !== this.id || this.phase !== 'showing') return false
    this.clearTimer()
    if (this.reduced) {
      this.phase = 'idle'
      this.unfreeze()
      this.host.layout()
      if (this.onScreen) this.send({ type: 'target', seq: 1, kind: this.kind, to: this.onScreen })
      return true
    }
    this.phase = 'moving'
    this.unfreeze()
    this.host.layout()
    // Back where it was (the change undone meanwhile): nothing to move.
    if (this.from && this.target && samePlacement(this.from, this.target)) this.finish()
    return true
  }

  /** The snapshot rests on target `seq`: the live view comes back, and then the snapshot goes. */
  landed(id: number, seq: number) {
    if (id !== this.id || this.phase !== 'moving' || seq !== this.seq) return
    this.clearTimer()
    this.phase = 'ending'
    this.host.layout()
    void this.nextFrame().then(() => {
      if (this.id === id && this.phase === 'ending') this.end()
    })
  }

  /** A click on the moving snapshot. */
  cancel(id: number) {
    if (id === this.id) this.finish()
  }

  /**
   * The live view in its new place now, without the rest of the motion: for a pick, a tab
   * switch, the page going away. `relayout` false from inside a layout, which places the view.
   */
  finish(relayout = true) {
    if (this.phase === 'idle') return
    const id = this.id
    this.phase = 'idle'
    this.clearTimer()
    this.unfreeze()
    if (relayout) this.host.layout()
    this.host.send({ type: 'end', id })
  }

  dispose() {
    this.finish(false)
  }

  private async capture(id: number, from: MorphPlacement) {
    const asked = performance.now()
    const frozen = new Promise<void>((resolve) => {
      this.release = resolve
    })
    let capture = 0
    // In the lock, so it's the layout on screen: an agent's screenshot can emulate another
    // width for a moment, and the change's own emulation waits behind it.
    const captured = new Promise<NativeImage | null>((resolve) => {
      void this.host.exclusive(async () => {
        if (!this.current(id)) return resolve(null)
        const started = performance.now()
        const image = await this.host.view.webContents.capturePage().catch(() => null)
        capture = performance.now() - started
        resolve(image)
        await frozen
      })
    })
    const image = await Promise.race([captured, sleep(CAPTURE_BUDGET_MS).then(() => null)])
    if (!this.current(id)) return
    if (!image || image.isEmpty()) return this.finish()
    const wait = performance.now() - asked
    const encoding = performance.now()
    const jpeg = image.toJPEG(JPEG_QUALITY)
    record({ capture, wait, encode: performance.now() - encoding })
    // Read when the morph starts, like the panel's flights, so a change applies from the next one.
    this.reduced = prefersReducedMotion()
    this.phase = 'showing'
    this.send({ type: 'snapshot', kind: this.kind, image: jpeg, from, reduced: this.reduced })
    this.timer = setTimeout(() => this.finish(), SHOWN_TIMEOUT_MS)
  }

  private retarget(to: MorphPlacement) {
    this.target = to
    const seq = ++this.seq
    this.send({ type: 'target', seq, kind: this.kind, to })
    this.clearTimer()
    this.timer = setTimeout(() => this.finish(), LAND_TIMEOUT_MS)
    void this.captureAfter(this.id, seq, to)
  }

  /**
   * The preview at the morph's target, for the chrome to cross-fade into before the live view
   * comes back: in the lock, after the change's emulation, once the page has drawn its new
   * layout.
   */
  private async captureAfter(id: number, seq: number, to: MorphPlacement) {
    const image = await this.host.exclusive(async () => {
      for (let attempt = 1; attempt <= AFTER_ATTEMPTS; attempt++) {
        await this.nextFrame()
        if (!this.current(id, seq)) return null
        const shot = await this.host.view.webContents.capturePage().catch(() => null)
        if (shot && !shot.isEmpty() && this.fits(shot, to.rect)) return shot
      }
      return null
    })
    if (!this.current(id, seq)) return
    this.send({ type: 'after', seq, image: image ? image.toJPEG(JPEG_QUALITY) : null })
  }

  /** A capture of the whole view at `rect`'s size, in the display's pixels. */
  private fits(image: NativeImage, rect: Rect) {
    const { width, height } = image.getSize()
    let density = 1
    try {
      density = screen.getDisplayMatching(this.host.window().getBounds()).scaleFactor
    } catch {
      // A window gone: the capture is dropped anyway.
    }
    const close = (pixels: number, points: number) => Math.abs(pixels - points * density) <= density
    return close(width, rect.width) && close(height, rect.height)
  }

  /** Once the preview has drawn a frame, or a little later for a page too busy to draw one. */
  private nextFrame() {
    const wc = this.host.view.webContents
    const frame = wc.isDestroyed()
      ? Promise.resolve()
      : wc
          .executeJavaScriptInIsolatedWorld(PAINT_WORLD, [{ code: NEXT_FRAME }])
          .catch(() => undefined)
    return Promise.race([frame, sleep(PAINT_TIMEOUT_MS)])
  }

  private end() {
    const id = this.id
    this.phase = 'idle'
    this.clearTimer()
    this.host.send({ type: 'end', id })
  }

  private current(id: number, seq?: number) {
    return id === this.id && this.phase !== 'idle' && (seq === undefined || seq === this.seq)
  }

  private unfreeze() {
    this.release?.()
    this.release = null
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One of this morph's events, numbered with its id. */
  private send(event: Unnumbered<MorphEvent>) {
    this.host.send({ ...event, id: this.id })
  }
}

/**
 * The view's place while out of sight: its size kept, so its page stays laid out there, with
 * one pixel (its top-right) left inside the window, at the window's bottom-left corner.
 */
function outOfSight(rect: Rect, contentHeight: number): Rect {
  return { x: 1 - rect.width, y: contentHeight - 1, width: rect.width, height: rect.height }
}

function samePlacement(a: MorphPlacement, b: MorphPlacement) {
  return (
    a.frame === b.frame &&
    Math.abs(a.scale - b.scale) < 0.0005 &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  )
}

function record(timing: MorphTiming) {
  timings.push(timing)
  if (timings.length > 200) timings.shift()
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
