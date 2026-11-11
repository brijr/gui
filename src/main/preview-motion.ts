import { nativeImage, type WebContents } from 'electron'
import { type PageRect, pagePoint, pageRectFromViewport, viewportRectFrom } from '../shared/coords'
import type { Inspector } from './inspector'
import type { PreviewInteractions } from './preview-interactions'
import {
  type Bitmap,
  composeSheet,
  frameLabel,
  type MotionPlan,
  motionSummary,
  motionTimeline,
  type SheetLayout,
  sheetLayout,
} from './preview-motion-format'
import { RecordingTrace } from './recording-trace'

/**
 * preview_motion: plays motion in the user's app (an input, a replay, a reload, or nothing)
 * and films it: a contact sheet of timed frames, and a timeline of the animations that ran
 * (traced the way a user's recording is, recording-trace.ts). The request, sheet and text are
 * in preview-motion-format.ts.
 */

/** Under Claude's 5 MB per image, with room to spare. */
const MAX_SHEET_BYTES = 4 * 1024 * 1024
/** Margin around a cropped element, CSS px. */
const CROP_MARGIN = 24
/** A media query change restyles the page on its next frame. */
const MEDIA_SETTLE_MS = 100
/** Elements whose CSS animations `replay` restarts; a page with more restarts these. */
const MAX_REPLAY_ELEMENTS = 5000
/** Its own world, so it can trace while a user's recording traces in recording-trace's. */
const MOTION_WORLD = 1004

// ---- Filming ----

export interface MotionDeps {
  wc: WebContents
  inspector: Inspector
  assertLoaded: () => void
  /** The agent's input, marked as its own (PageTools.input) */
  input: <T>(action: (interactions: PreviewInteractions) => Promise<T>) => Promise<T>
}

export interface FilmedMotion {
  image: { data: string; mimeType: 'image/jpeg'; width: number; height: number }
  /** Gui's own account of what it did, safe outside a fence */
  summary: string
  /** Page content (selectors, text): fence it */
  timeline: string
}

interface LayoutMetrics {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
}

interface Frame {
  /** Wall-clock ms from the start of filming */
  at: number
  data: string | null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Epoch ms, on the clock the page's trace uses */
const now = () => performance.timeOrigin + performance.now()

/**
 * Restarts the page's CSS animations (by taking their names away for a style pass) and Web
 * Animations (from 0). Runs in Gui's world; how many it restarted.
 */
const RESTART = `(() => {
  let count = 0
  const restyled = []
  let seen = 0
  for (const el of document.querySelectorAll('*')) {
    if (++seen > ${MAX_REPLAY_ELEMENTS}) break
    const name = getComputedStyle(el).animationName
    if (!name || name === 'none') continue
    restyled.push([el, el.style.getPropertyValue('animation-name'), el.style.getPropertyPriority('animation-name')])
    el.style.setProperty('animation-name', 'none', 'important')
  }
  void document.documentElement.offsetWidth
  for (const [el, value, priority] of restyled) {
    if (value) el.style.setProperty('animation-name', value, priority)
    else el.style.removeProperty('animation-name')
    if (!el.getAttribute('style')) el.removeAttribute('style')
  }
  count += restyled.length
  for (const animation of document.getAnimations()) {
    if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue
    animation.currentTime = 0
    if (animation.playState !== 'running') animation.play()
    count++
  }
  return count
})()`

async function devicePixelRatio(inspector: Inspector) {
  const { result } = await inspector.command<{ result: { value: unknown } }>('Runtime.evaluate', {
    expression: 'devicePixelRatio',
    returnByValue: true,
  })
  const value = Number(result.value)
  return Number.isFinite(value) && value > 0 && value <= 4 ? value : 1
}

/** The part of the page on screen, in page coordinates. */
async function visibleArea(inspector: Inspector): Promise<PageRect> {
  const { cssVisualViewport: view } =
    await inspector.command<LayoutMetrics>('Page.getLayoutMetrics')
  return pageRectFromViewport(
    viewportRectFrom({ x: 0, y: 0, width: view.clientWidth, height: view.clientHeight }),
    pagePoint(view.pageX, view.pageY),
  )
}

/** `selector`'s box with a margin, on screen (scrolled into view first), in page coordinates. */
async function cropArea(inspector: Inspector, selector: string): Promise<PageRect> {
  return inspector.exclusive(async (session) => {
    const backendNodeId = await session.querySelector(selector)
    await inspector.command('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
    const { model } = await inspector
      .command<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId })
      .catch(() => {
        throw new Error(`${selector} isn't rendered (it has no layout box), so it can't be filmed`)
      })
    const xs = [model.border[0], model.border[2], model.border[4], model.border[6]]
    const ys = [model.border[1], model.border[3], model.border[5], model.border[7]]
    const element = viewportRectFrom({
      x: Math.min(...xs) - CROP_MARGIN,
      y: Math.min(...ys) - CROP_MARGIN,
      width: Math.max(...xs) - Math.min(...xs) + CROP_MARGIN * 2,
      height: Math.max(...ys) - Math.min(...ys) + CROP_MARGIN * 2,
    })
    const visible = await visibleArea(inspector)
    const area = pageRectFromViewport(element, pagePoint(visible.x, visible.y))
    // Within the viewport: filming beyond it would resize the view mid-animation.
    const x = Math.max(area.x, visible.x)
    const y = Math.max(area.y, visible.y)
    const right = Math.min(area.x + area.width, visible.x + visible.width)
    const bottom = Math.min(area.y + area.height, visible.y + visible.height)
    if (right - x < 4 || bottom - y < 4) throw new Error(`${selector} isn't on screen to film`)
    return { ...area, x, y, width: right - x, height: bottom - y }
  })
}

/** Frames on schedule from `start`, each from the surface as composited. */
async function capture(
  inspector: Inspector,
  plan: MotionPlan,
  crop: PageRect | null,
  layout: SheetLayout,
  dpr: number,
  start: number,
): Promise<Frame[]> {
  const frames: Frame[] = []
  for (let index = 0; index < plan.frames; index++) {
    const due = start + (plan.filmingMs * index) / (plan.frames - 1)
    const wait = due - now()
    if (wait > 0) await sleep(wait)
    let at = now() - start
    try {
      // The viewport's area moves as the page scrolls; an element's stays put in the page.
      const area = crop ?? (await visibleArea(inspector))
      const scale = Math.min(1, layout.cellWidth / (area.width * dpr))
      const sent = now()
      const { data } = await inspector.command<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 85,
        clip: { x: area.x, y: area.y, width: area.width, height: area.height, scale },
        captureBeyondViewport: false,
        fromSurface: true,
      })
      // It draws a fresh frame and reads it back (35–60 ms in all), so the frame shows the
      // page about halfway through the call rather than as it was when asked.
      at = (sent + now()) / 2 - start
      frames.push({ at, data })
    } catch {
      // Mid-reload there can be nothing to capture for a moment.
      frames.push({ at, data: null })
    }
  }
  return frames
}

/** A captured JPEG at the sheet's cell size, as pixels; null when it can't be read. */
function decode(data: string | null, width: number, height: number): Bitmap | null {
  if (!data) return null
  let image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
  if (image.isEmpty()) return null
  const size = image.getSize()
  if (size.width !== width || size.height !== height)
    image = image.resize({ width, height, quality: 'good' })
  const pixels = image.toBitmap()
  if (pixels.length !== width * height * 4) return null
  return { width, height, pixels }
}

function encode(sheet: Bitmap) {
  const image = nativeImage.createFromBitmap(Buffer.from(sheet.pixels), {
    width: sheet.width,
    height: sheet.height,
  })
  let jpeg = image.toJPEG(85)
  if (jpeg.length > MAX_SHEET_BYTES) jpeg = image.toJPEG(60)
  if (jpeg.length > MAX_SHEET_BYTES)
    throw new Error('The filmstrip came out too large; film fewer frames or pass `crop`.')
  return jpeg.toString('base64')
}

/** The last filming of each page: one at a time, as they share its trace and playback rate. */
const filming = new WeakMap<WebContents, Promise<unknown>>()

/**
 * Plays the motion `plan` asks for and films it, after any filming of the page already under
 * way. Slow motion and reduced motion are the page's until this returns or throws, then undone.
 */
export function filmMotion(deps: MotionDeps, plan: MotionPlan): Promise<FilmedMotion> {
  const run = (filming.get(deps.wc) ?? Promise.resolve()).then(() => film(deps, plan))
  filming.set(
    deps.wc,
    run.catch(() => undefined),
  )
  return run
}

async function film(deps: MotionDeps, plan: MotionPlan): Promise<FilmedMotion> {
  const { wc, inspector } = deps
  deps.assertLoaded()
  let slowed = false
  let reduced = false
  let trace: RecordingTrace | null = null
  let navigated: (() => void) | null = null
  try {
    if (plan.reducedMotion) {
      reduced = true
      // Nothing else in Gui emulates media features; this call replaces all of them.
      await inspector.command('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      })
    }
    if (plan.slowMotion !== 1) {
      slowed = true
      await inspector.command('Animation.enable')
      await inspector.command('Animation.setPlaybackRate', { playbackRate: 1 / plan.slowMotion })
    }
    if (reduced) await sleep(MEDIA_SETTLE_MS)
    const crop = plan.crop ? await cropArea(inspector, plan.crop) : null
    const dpr = await devicePixelRatio(inspector)
    const first = crop ?? (await visibleArea(inspector))
    const layout = sheetLayout(plan.frames, {
      width: first.width * dpr,
      height: first.height * dpr,
    })

    let restarted = 0
    if (plan.play === 'replay') {
      restarted = Number(
        await wc.executeJavaScriptInIsolatedWorld(MOTION_WORLD, [{ code: RESTART }]),
      )
      if (!restarted)
        throw new Error(
          'Nothing to replay: the page has no CSS animations or Web Animations. Transitions need the change that starts them; play it with click, hover, press or scroll.',
        )
    }
    // After a replay's restart, so its own style changes aren't traced.
    trace = new RecordingTrace(wc, MOTION_WORLD)
    await trace.ready()

    switch (plan.play) {
      case 'click':
      case 'hover': {
        const target = plan.selector ?? ''
        const action = plan.play
        await deps.input((interactions) => interactions[action](target))
        break
      }
      case 'press': {
        const key = plan.key ?? 'Enter'
        await deps.input((interactions) => interactions.press(key, plan.selector))
        break
      }
      case 'scroll':
        await deps.input((interactions) => interactions.scroll(plan.deltaY, 0, plan.selector))
        break
      case 'reload': {
        const current = trace
        await current.navigating()
        navigated = () => current.navigated(wc.getURL())
        wc.once('dom-ready', navigated)
        wc.reload()
        break
      }
    }
    const start = now()
    const frames = await inspector.exclusive((session) =>
      session.withoutHighlight(() => capture(inspector, plan, crop, layout, dpr, start)),
    )
    const entries = await trace.finish(start, plan.filmingMs)
    trace = null
    deps.assertLoaded()

    const bitmaps = frames.map((frame) => decode(frame.data, layout.cellWidth, layout.cellHeight))
    if (bitmaps.every((bitmap) => !bitmap))
      throw new Error(
        'No frame could be captured; check the preview is showing the app and try again.',
      )
    const labels = frames.map((frame, index) => frameLabel(index, frame.at / plan.slowMotion))
    const sheet = composeSheet(layout, bitmaps, labels)
    const image = {
      data: encode(sheet),
      mimeType: 'image/jpeg' as const,
      width: sheet.width,
      height: sheet.height,
    }
    const timed = frames.map((frame, index) => ({
      at: frame.at / plan.slowMotion,
      captured: bitmaps[index] !== null,
    }))
    return {
      image,
      summary: motionSummary(plan, timed, image, restarted),
      timeline: motionTimeline(entries, {
        slowMotion: plan.slowMotion,
        replayed: plan.play === 'replay',
      }),
    }
  } finally {
    if (navigated) wc.off('dom-ready', navigated)
    trace?.dispose()
    if (slowed) {
      await inspector.command('Animation.setPlaybackRate', { playbackRate: 1 }).catch(() => {})
      await inspector.command('Animation.disable').catch(() => {})
    }
    if (reduced)
      await inspector.command('Emulation.setEmulatedMedia', { features: [] }).catch(() => {})
  }
}
