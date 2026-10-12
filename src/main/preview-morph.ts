import { performance } from 'node:perf_hooks'
import { app, type BrowserWindow } from 'electron'
import { Spring } from '../shared/motion'
import {
  type MorphEvent,
  type MorphKind,
  type MorphPlacement,
  type Rect,
  viewportSpec,
} from '../shared/types'
import { onDisplayFrames, prefersReducedMotion } from './panel-flight'
import type { Emulation } from './viewport'

/*
 * A change that moves or resizes the preview (another viewport, a zoom step, the drawer, the
 * docked chat, focus mode) resizes the live page into its new layout, the way dragging a
 * window's edge would: the view's bounds and its emulated viewport spring there together,
 * stepped on the display's frames, and the user's app lays itself out again at every size on
 * the way. Its media queries flip mid-motion, as they would in a window being resized.
 *
 * 1. Before the change, `request` arms a morph from where the view is on screen.
 * 2. The next layout that places the view elsewhere starts it: from there, each frame places
 *    the view (and its emulation) where the springs have got to, and tells the chrome, which
 *    draws the device frame's edge and label around it (renderer app/layout-morph.ts).
 * 3. Once every spring rests, the tab lays out at its exact layout, and the morph ends.
 *
 * A change mid-morph retargets the springs from wherever they are, keeping their speed.
 */

/** Armed and never placed elsewhere in this long (the change moved nothing): it's dropped. */
const ARMED_TIMEOUT_MS = 300
/** Close enough to rest: half a pixel, or as good for the scale and the frame's opacity. */
const PRECISION = { x: 0.5, y: 0.5, w: 0.5, h: 0.5, s: 0.0005, frame: 0.002 } as const
type Key = keyof typeof PRECISION
const KEYS = Object.keys(PRECISION) as Key[]
/** Steps follow real time; a stall longer than this is taken as this long. */
const MAX_STEP = 0.1

/** Unique across tabs, so the chrome never takes one tab's morph for another's. */
let lastId = 0

/**
 * The morphs armed or moving, by id, for the end-to-end tests to wait out (unpackaged builds
 * only): mid-morph the view is between layouts.
 */
const morphing = new Set<number>()
if (!app.isPackaged) (globalThis as { guiMorphing?: Set<number> }).guiMorphing = morphing

type Phase = 'idle' | 'armed' | 'moving'

/** A morph event without its id, which `PreviewMorph.send` adds. */
type Unnumbered<E> = E extends MorphEvent ? Omit<E, 'id'> : never

/** Where the view is mid-morph, and what its page is laid out at there. */
export interface LivePlacement {
  rect: Rect
  emulation: Emulation | null
}

/** The tab (tab.ts) whose preview morphs. */
export interface MorphHost {
  /** The window the tab is in now (a tab can move to another) */
  window(): BrowserWindow
  /** To the window's chrome, while the tab is the one it shows */
  send(event: MorphEvent): void
  /** Lays the tab out again, which places the view through `place` */
  layout(): void
  /** Places the view mid-morph, between layouts */
  apply(at: LivePlacement): void
  /** The preview has started moving: what moves with it in main (the docked chat) starts now. */
  moving(reduced: boolean): void
  /** The morph is over, landed or cut short: whatever moves with it lands too. */
  ended(): void
}

export class PreviewMorph {
  private phase: Phase = 'idle'
  private id = 0
  private kind: MorphKind = 'viewport'
  /** Where the view is on screen: the layout it was last placed at, outside a morph. */
  private onScreen: MorphPlacement | null = null
  private from: MorphPlacement | null = null
  private target: MorphPlacement | null = null
  private springs: Record<Key, Spring> | null = null
  private stopFrames: (() => void) | null = null
  private last = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly host: MorphHost) {}

  /** From the change until the view rests in its new layout. */
  get active() {
    return this.phase !== 'idle'
  }

  /**
   * Before a change that moves or resizes the preview. Out of a morph, and `eligible` (the
   * preview on screen, nothing being picked), it arms one from where the view is; mid-morph,
   * the change only retargets it.
   */
  request(kind: MorphKind, eligible: boolean) {
    if (this.phase === 'moving') {
      this.kind = kind
      return
    }
    const from = this.onScreen
    if (!eligible || !from || from.rect.width < 1 || from.rect.height < 1) return
    if (prefersReducedMotion()) return
    if (this.phase === 'idle') this.id = ++lastId
    this.kind = kind
    this.from = from
    this.phase = 'armed'
    morphing.add(this.id)
    // First, so the chrome holds the drawer or the toolbar until the preview moves with them.
    this.send({ type: 'pending', kind })
    this.clearTimer()
    this.timer = setTimeout(() => this.finish(false), ARMED_TIMEOUT_MS)
  }

  /**
   * Where the view goes for the layout `wanted`: null to put it there, or mid-morph where the
   * springs have got to on their way to it.
   */
  place(wanted: MorphPlacement): LivePlacement | null {
    if (this.phase === 'armed' && this.from && !samePlacement(this.from, wanted)) {
      this.start(this.from, wanted)
    }
    if (this.phase !== 'moving') {
      this.onScreen = wanted
      return null
    }
    if (!this.target || !samePlacement(this.target, wanted)) this.retarget(wanted)
    return this.current()
  }

  /**
   * The view in its new place now, without the rest of the motion: for a pick, a tab switch,
   * the page going away. `relayout` false from inside a layout, which places the view.
   */
  finish(relayout = true) {
    if (this.phase === 'idle') return
    const id = this.id
    const moved = this.phase === 'moving'
    this.phase = 'idle'
    morphing.delete(id)
    this.clearTimer()
    this.stopFrames?.()
    this.stopFrames = null
    this.springs = null
    if (moved && this.target) this.onScreen = this.target
    if (relayout) this.host.layout()
    this.host.send({ type: 'end', id })
    this.host.ended()
  }

  dispose() {
    this.finish(false)
  }

  private start(from: MorphPlacement, to: MorphPlacement) {
    this.clearTimer()
    this.phase = 'moving'
    this.target = to
    this.springs = {
      x: new Spring(from.rect.x),
      y: new Spring(from.rect.y),
      w: new Spring(from.rect.width),
      h: new Spring(from.rect.height),
      s: new Spring(from.scale),
      frame: new Spring(from.frame ? 1 : 0),
    }
    this.retarget(to)
    this.last = performance.now()
    this.stopFrames = onDisplayFrames(this.host.window().webContents, () => {
      try {
        this.tick()
      } catch (error) {
        // A window gone mid-morph: land rather than fail at the display's rate.
        this.finish(false)
        console.error('[gui] preview morph stopped', error)
      }
    })
    this.host.moving(false)
    this.sendFrame()
  }

  private retarget(to: MorphPlacement) {
    this.target = to
    const { springs } = this
    if (!springs) return
    springs.x.retarget(to.rect.x)
    springs.y.retarget(to.rect.y)
    springs.w.retarget(to.rect.width)
    springs.h.retarget(to.rect.height)
    springs.s.retarget(to.scale)
    springs.frame.retarget(to.frame ? 1 : 0)
  }

  private tick() {
    const { springs } = this
    if (this.phase !== 'moving' || !springs) return
    const now = performance.now()
    const dt = Math.min((now - this.last) / 1000, MAX_STEP)
    this.last = now
    for (const key of KEYS) springs[key].step(dt)
    if (KEYS.every((key) => springs[key].atRest(PRECISION[key]))) return this.finish()
    this.host.apply(this.current())
    this.sendFrame()
  }

  /** The view where the springs are, its page laid out at that size over the scale. */
  private current(): LivePlacement {
    const springs = this.springs
    const to = this.target
    if (!springs || !to) throw new Error('No morph')
    const rect = {
      x: Math.round(springs.x.value),
      y: Math.round(springs.y.value),
      width: Math.max(1, Math.round(springs.w.value)),
      height: Math.max(1, Math.round(springs.h.value)),
    }
    // Desktop at 100% at both ends: the view simply resizes, like a window.
    if (!emulates(this.from) && !emulates(to)) return { rect, emulation: null }
    const scale = Math.max(0.05, Math.round(springs.s.value * 1000) / 1000)
    const emulation = {
      width: Math.max(1, Math.round(rect.width / scale)),
      height: Math.max(1, Math.round(rect.height / scale)),
      scale,
      // The device it's going to: its meta viewport and touch apply all the way.
      mobile: to.frame ? viewportSpec(to.frame).mobile : false,
    }
    return { rect, emulation }
  }

  /** Where the preview is now, for the chrome to draw the device frame around. */
  private sendFrame() {
    const springs = this.springs
    const to = this.target
    if (!springs || !to) return
    const { rect } = this.current()
    this.send({
      type: 'frame',
      kind: this.kind,
      rect,
      scale: springs.s.value,
      // The device the label names: where it's going, or the one it's leaving for Desktop.
      viewport: to.frame ?? this.from?.frame ?? null,
      opacity: Math.min(1, Math.max(0, springs.frame.value)),
    })
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

/** A device frame, or Desktop zoomed: the page laid out at its own size, drawn scaled. */
function emulates(placement: MorphPlacement | null) {
  return placement !== null && (placement.frame !== null || Math.abs(placement.scale - 1) >= 0.0005)
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
