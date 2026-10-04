import { type RefObject, useLayoutEffect, useSyncExternalStore } from 'react'
import { FRAME_LABEL_HEIGHT } from '../../../shared/layout'
import { Spring } from '../../../shared/motion'
import {
  frameLabel,
  type MorphEvent,
  type MorphKind,
  type MorphPlacement,
  type Rect,
  type Viewport,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { animateFade, onFrames } from '../lib/motion'

/*
 * The chrome's side of the preview's layout morphs (main/preview-morph.ts): a snapshot of the
 * preview, drawn where the live view was while main takes the view out of sight, springs to
 * where the view is going and cross-fades into a capture of it there; then main puts the live
 * view back over it. The device frame's edge and label move with it. Drawn over the canvas and
 * under the toolbar and the drawer. Transform and opacity only, except the frame's
 * edge, which is resized rather than scaled so its hairline and shadow stay true.
 *
 * The pictures are never stretched. When another viewport lays the page out anew, the old
 * picture isn't scaled into the new frame's shape for the whole way: the frame resizes around
 * the page, drawn at the frame's scale, and the old layout dissolves into the new one early in
 * the motion, over the page's own background. The eye follows the frame's edge, never a
 * distorted page, and the frame lands on the real new layout. The same page at a new size (a
 * zoom, the drawer, the docked chat, focus mode) keeps its picture until the last moments.
 */

/** The clip box's own size: it's scaled to the rect it clips, its contents scaled back. */
const BASE = 1000
/** The capture at the target fades in where nothing covers it yet. */
const FADE_IN_S = 0.1
/** The same page at its new size: the capture there takes over in the motion's last moments. */
const END_FADE_S = 0.08
const END_FADE_AT = 0.9
/** The page laid out anew: the old picture dissolves into the new one early in the motion. */
const REFLOW_FADE_S = 0.12
const REFLOW_FROM = 0.15
const REFLOW_TO = 0.75
/** At rest without a capture at the target: how long it's waited for before landing anyway. */
const AFTER_WAIT_MS = 250
/** Reduce motion: the snapshot's fade where the live view isn't (--motion-fade). */
const REDUCED_FADE_MS = 150
/** Landed and not ended by main after this long: the snapshot goes anyway. */
const STALE_MS = 2000

type Key = 'x' | 'y' | 'w' | 'h' | 's' | 'ax' | 'ay' | 'frame'
const KEYS: readonly Key[] = ['x', 'y', 'w', 'h', 's', 'ax', 'ay', 'frame']
/** Close enough to rest: half a pixel, or as good for scales, anchors and opacity. */
const PRECISION: Record<Key, number> = {
  x: 0.5,
  y: 0.5,
  w: 0.5,
  h: 0.5,
  s: 0.0005,
  ax: 0.002,
  ay: 0.002,
  frame: 0.002,
}
/** What progress is measured on, and the least change that counts as moving. */
const MOVES: readonly [Key, number][] = [
  ['x', 1],
  ['y', 1],
  ['w', 1],
  ['h', 1],
  ['s', 0.002],
]

// The canvas leaves its own device frame out while the morph draws it.

interface Status {
  id: number
  moving: boolean
  /** The morph draws the device frame (not with Reduce motion, where it's simply there) */
  drawsFrame: boolean
}

let status: Status | null = null
const listeners = new Set<() => void>()

function setStatus(next: Status | null) {
  status = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while a morph draws the device frame, which the canvas then leaves out. */
export function useMorphDrawsFrame() {
  return useSyncExternalStore(subscribe, () => status?.drawsFrame ?? false)
}

/** The canvas (canvas.tsx), as the change has laid it out by now. */
function canvasRect(): Rect {
  const canvas = document.querySelector('main')
  if (!canvas) return { x: 0, y: 0, width: innerWidth, height: innerHeight }
  const { x, y, width, height } = canvas.getBoundingClientRect()
  return { x, y, width, height }
}

/**
 * Where the pictures are pinned in the morphing frame. Each is drawn at the frame's scale
 * (`s`), never stretched: the frame moves and resizes around the page the way a window resized
 * by hand would, uncovering or covering it from its top-left corner, where pages lay out from.
 * A zoom of Desktop scales it around the middle instead, like a camera.
 */
function anchorFor(kind: MorphKind, at: MorphPlacement) {
  return kind === 'zoom' && at.frame === null ? 0.5 : 0
}

interface Layer {
  picture: HTMLCanvasElement
  /** The page's own background, by its bottom-right corner, for the frame around it */
  background: string
  /** The rect it was captured at, in CSS pixels, and the scale its page was drawn at there */
  width: number
  height: number
  scale: number
  opacity: number
  /** The target it was captured at; 0 for the snapshot from before the change */
  seq: number
}

/**
 * A JPEG from main as a canvas of `width` × `height` CSS pixels: decoded off the main thread,
 * then handed to the canvas without a copy.
 */
async function loadPicture(bytes: Uint8Array, width: number, height: number) {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }))
  const picture = document.createElement('canvas')
  picture.width = bitmap.width
  picture.height = bitmap.height
  const context = picture.getContext('bitmaprenderer')
  if (!context) {
    bitmap.close()
    throw new Error('No bitmap renderer')
  }
  const background = cornerColor(bitmap)
  context.transferFromImageBitmap(bitmap)
  picture.className = 'absolute top-0 left-0 origin-top-left will-change-transform'
  picture.style.width = `${width}px`
  picture.style.height = `${height}px`
  return { picture, background }
}

/**
 * The color just inside the picture's bottom-right corner: most pages' background there, which
 * the frame shows where a picture doesn't reach it (a narrow layout in a wider frame).
 */
function cornerColor(bitmap: ImageBitmap) {
  const pixel = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
  if (!pixel) return ''
  pixel.drawImage(bitmap, bitmap.width - 2, bitmap.height - 2, 1, 1, 0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = pixel.getImageData(0, 0, 1, 1).data
  return `rgb(${r} ${g} ${b})`
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** `value` moved toward `target` by at most `step`. */
function approach(value: number, target: number, step: number) {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step)
}

function smoothstep(from: number, to: number, value: number) {
  const t = clamp01((value - from) / (to - from))
  return t * t * (3 - 2 * t)
}

/** One morph: from the snapshot's arrival until main puts the live view back (`end`). */
class Morph {
  readonly id: number
  private kind: MorphKind
  private readonly reduced: boolean
  private readonly el = document.createElement('div')
  private readonly edge = document.createElement('div')
  private readonly box = document.createElement('div')
  private readonly inner = document.createElement('div')
  private readonly label = document.createElement('p')
  private readonly springs: Record<Key, Spring>
  /** Each value where the last retarget found it, to measure progress from. */
  private readonly start: Record<Key, number>
  /** Bottom to top: the newest capture at the bottom, older pictures fading out over it. */
  private layers: Layer[] = []
  private seq = 0
  private to: MorphPlacement | null = null
  private afterFailed = false
  private restingSince: number | null = null
  private stop: (() => void) | null = null
  private staleTimer = 0
  private disposed = false

  constructor(event: Extract<MorphEvent, { type: 'snapshot' }>, root: HTMLElement) {
    const { id, kind, from, reduced, image } = event
    this.id = id
    this.kind = kind
    this.reduced = reduced
    const anchor = anchorFor(kind, from)
    const values: Record<Key, number> = {
      x: from.rect.x,
      y: from.rect.y,
      w: from.rect.width,
      h: from.rect.height,
      s: from.scale,
      ax: anchor,
      ay: anchor,
      frame: from.frame ? 1 : 0,
    }
    this.springs = {
      x: new Spring(values.x),
      y: new Spring(values.y),
      w: new Spring(values.w),
      h: new Spring(values.h),
      s: new Spring(values.s),
      ax: new Spring(values.ax),
      ay: new Spring(values.ay),
      frame: new Spring(values.frame),
    }
    this.start = { ...values }

    this.el.className = 'absolute inset-0'
    this.el.dataset.morph = String(id)
    this.box.dataset.morphSnapshot = ''
    this.edge.dataset.morphFrame = ''
    this.edge.className = 'absolute top-0 left-0 border border-line-strong shadow-popover'
    this.box.className =
      'pointer-events-auto absolute top-0 left-0 origin-top-left overflow-hidden will-change-transform'
    this.box.style.width = `${BASE}px`
    this.box.style.height = `${BASE}px`
    this.inner.className = 'absolute top-0 left-0 origin-top-left'
    this.label.className =
      'absolute top-0 left-0 flex items-center text-caption whitespace-nowrap text-subtle tabular-nums'
    this.label.style.height = `${FRAME_LABEL_HEIGHT}px`
    if (from.frame) this.setLabel(from.frame, from.scale)
    // A click on it is meant for the page: the live view, in its new place, at once.
    this.box.addEventListener('pointerdown', (pointer) => {
      pointer.preventDefault()
      gui.cancelMorph(this.id)
    })
    this.box.append(this.inner)
    this.el.append(this.edge, this.box, this.label)
    this.draw()
    root.append(this.el)
    void this.show(image, from)
  }

  /** Where it's going now (again for every change before it lands), from wherever it is. */
  target({ seq, kind, to }: Extract<MorphEvent, { type: 'target' }>) {
    this.seq = seq
    this.kind = kind
    this.to = to
    this.afterFailed = false
    this.restingSince = null
    clearTimeout(this.staleTimer)
    if (this.reduced) return this.fadeOut()
    const anchor = anchorFor(kind, to)
    const targets: Record<Key, number> = {
      x: to.rect.x,
      y: to.rect.y,
      w: to.rect.width,
      h: to.rect.height,
      s: to.scale,
      ax: anchor,
      ay: anchor,
      frame: to.frame ? 1 : 0,
    }
    for (const key of KEYS) {
      this.springs[key].retarget(targets[key])
      this.start[key] = this.springs[key].value
    }
    if (to.frame) this.setLabel(to.frame, to.scale)
    setStatus({ id: this.id, moving: true, drawsFrame: true })
    this.run()
  }

  /** The preview captured at target `seq`; null when it couldn't be. */
  async after({ seq, image }: Extract<MorphEvent, { type: 'after' }>) {
    if (seq !== this.seq || this.reduced) return
    const to = this.to
    const { width = 0, height = 0 } = to?.rect ?? {}
    const loaded = image && to ? await loadPicture(image, width, height).catch(() => null) : null
    if (this.disposed || seq !== this.seq || !to) return
    if (!loaded) {
      this.afterFailed = true
      this.run()
      return
    }
    this.layers.unshift({ ...loaded, width, height, scale: to.scale, opacity: 0, seq })
    this.inner.prepend(loaded.picture)
    this.box.style.backgroundColor = loaded.background
    this.draw()
    this.run()
  }

  dispose() {
    this.disposed = true
    this.stop?.()
    this.stop = null
    clearTimeout(this.staleTimer)
    this.layers = []
    this.el.remove()
  }

  /** The snapshot where the preview is, then (once it's on screen) main takes the view away. */
  private async show(image: Uint8Array, from: MorphPlacement) {
    const { width, height } = from.rect
    const loaded = await loadPicture(image, width, height).catch(() => null)
    // Without it, main gives up waiting and puts the change in place at once.
    if (this.disposed || !loaded) return
    this.layers = [{ ...loaded, width, height, scale: from.scale, opacity: 1, seq: 0 }]
    this.inner.append(loaded.picture)
    this.box.style.backgroundColor = loaded.background
    this.draw()
    // A frame to draw it, another for it to be on screen.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!this.disposed) gui.morphShown(this.id, canvasRect())
      }),
    )
  }

  /**
   * Reduce motion: nothing moves. The live view is already in its new place over this, and the
   * canvas draws the frame there; the snapshot fades out where the view isn't.
   */
  private fadeOut() {
    this.edge.remove()
    this.label.remove()
    setStatus({ id: this.id, moving: true, drawsFrame: false })
    const before = this.layers.at(-1)
    this.stop?.()
    this.stop = animateFade(1, 0, REDUCED_FADE_MS, {
      update: (value) => {
        if (before) before.picture.style.opacity = String(value)
      },
      rest: () => this.finish(),
    })
  }

  private run() {
    if (this.stop || this.reduced) return
    if (document.visibilityState === 'hidden') {
      // No frames: wherever it's going, it's there.
      for (let pass = 0; pass < 10 && !this.tick(10); pass++);
      return
    }
    this.stop = onFrames((dt) => {
      const done = this.tick(dt)
      if (done) this.stop = null
      return done
    })
  }

  private tick(dt: number) {
    for (const key of KEYS) this.springs[key].step(dt)
    const progress = this.progress()
    const newest = this.layers[0]?.seq === this.seq ? this.layers[0] : null
    for (const layer of this.layers) {
      if (layer === newest) {
        layer.opacity = approach(layer.opacity, 1, dt / FADE_IN_S)
        continue
      }
      // Without the new picture yet, the old one stays.
      const reflow = this.reflows(layer)
      const end = progress >= END_FADE_AT ? 0 : 1
      const target = !newest ? 1 : reflow ? 1 - smoothstep(REFLOW_FROM, REFLOW_TO, progress) : end
      layer.opacity = approach(layer.opacity, target, dt / (reflow ? REFLOW_FADE_S : END_FADE_S))
    }
    this.layers = this.layers.filter((layer) => {
      if (layer === newest || layer.opacity > 0) return true
      layer.picture.remove()
      return false
    })
    this.draw()
    if (!KEYS.every((key) => this.springs[key].atRest(PRECISION[key]))) {
      this.restingSince = null
      return false
    }
    this.restingSince ??= performance.now()
    const crossed = newest
      ? newest.opacity >= 1 && this.layers.length === 1
      : this.afterFailed || performance.now() - this.restingSince > AFTER_WAIT_MS
    if (!crossed) return false
    for (const key of KEYS) this.springs[key].finish()
    this.draw()
    gui.morphLanded(this.id, this.seq)
    this.staleTimer = window.setTimeout(() => this.finish(), STALE_MS)
    return true
  }

  /** How far it has come since the last retarget, 0 to 1, by whichever value is furthest behind. */
  private progress() {
    let progress = 1
    for (const [key, least] of MOVES) {
      const spring = this.springs[key]
      const span = Math.abs(spring.target - this.start[key])
      if (span < least) continue
      progress = Math.min(progress, 1 - clamp01(Math.abs(spring.target - spring.value) / span))
    }
    return progress
  }

  /** The layer's page was laid out at another size than the target's: another viewport, or a zoom of Desktop. */
  private reflows(layer: Layer) {
    const to = this.to
    if (!to || (this.kind !== 'viewport' && this.kind !== 'zoom')) return false
    const differs = (a: number, b: number) => Math.abs(a - b) > Math.max(2, b * 0.01)
    return (
      differs(layer.width / layer.scale, to.rect.width / to.scale) ||
      differs(layer.height / layer.scale, to.rect.height / to.scale)
    )
  }

  private draw() {
    const value = (key: Key) => this.springs[key].value
    const x = value('x')
    const y = value('y')
    const w = Math.max(1, value('w'))
    const h = Math.max(1, value('h'))
    this.box.style.transform = `translate(${x}px, ${y}px) scale(${w / BASE}, ${h / BASE})`
    this.inner.style.transform = `scale(${BASE / w}, ${BASE / h})`
    for (const layer of this.layers) {
      // At the frame's scale, from the scale it was captured at.
      const k = value('s') / layer.scale
      const left = value('ax') * (w - layer.width * k)
      const top = value('ay') * (h - layer.height * k)
      layer.picture.style.transform = `translate(${left}px, ${top}px) scale(${k})`
      layer.picture.style.opacity = String(clamp01(layer.opacity))
    }
    const frame = String(clamp01(value('frame')))
    this.edge.style.opacity = frame
    this.edge.style.transform = `translate(${x - 1}px, ${y - 1}px)`
    this.edge.style.width = `${w + 2}px`
    this.edge.style.height = `${h + 2}px`
    this.label.style.opacity = frame
    this.label.style.transform = `translate(${x}px, ${y - FRAME_LABEL_HEIGHT}px)`
  }

  /** The label above a device frame, as canvas.tsx draws it. */
  private setLabel(viewport: Viewport, scale: number) {
    const { name, detail } = frameLabel(viewport, scale)
    const strong = document.createElement('span')
    strong.className = 'font-medium text-muted'
    strong.textContent = name
    const line = document.createElement('span')
    line.append(strong, detail)
    this.label.replaceChildren(line)
  }

  /** Done without main (Reduce motion, or main never ended it): gone. */
  private finish() {
    this.dispose()
    if (status?.id === this.id) setStatus(null)
  }
}

/** The morphs the chrome draws, one at a time, from main's `MorphEvent`s. */
class MorphLayer {
  private morph: Morph | null = null

  constructor(private readonly root: HTMLElement) {}

  handle(event: MorphEvent) {
    switch (event.type) {
      case 'pending':
        // The canvas keeps drawing the device frame where it is until the snapshot does.
        this.replace(null)
        setStatus({ id: event.id, moving: false, drawsFrame: false })
        break
      case 'snapshot':
        this.replace(new Morph(event, this.root))
        setStatus({ id: event.id, moving: false, drawsFrame: true })
        break
      case 'target':
        if (this.morph?.id === event.id) this.morph.target(event)
        break
      case 'after':
        if (this.morph?.id === event.id) void this.morph.after(event)
        break
      case 'end':
        if (this.morph?.id === event.id) this.replace(null)
        if (status?.id === event.id) setStatus(null)
        break
    }
  }

  dispose() {
    this.replace(null)
    setStatus(null)
  }

  private replace(morph: Morph | null) {
    this.morph?.dispose()
    this.morph = morph
  }
}

/**
 * Draws the morphs of the window's active `tab` in `ref`: over the canvas, under the toolbar
 * and the drawer. Another tab starts with none (main stops the old tab's morph when it goes).
 */
export function useLayoutMorphs(ref: RefObject<HTMLElement | null>, tab: string | null) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || tab === null) return
    const layer = new MorphLayer(root)
    const off = gui.onMorph((event) => layer.handle(event))
    return () => {
      off()
      layer.dispose()
    }
  }, [ref, tab])
}
