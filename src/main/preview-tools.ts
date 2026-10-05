import type { WebContents } from 'electron'
import type { ElementContext, Rect } from '../shared/types'
import { CROP_MARGIN, type Inspector, type InspectorSession } from './inspector'
import { isLoopback } from './loopback'
import type { Problems } from './problems'

/**
 * Images stay in the agent's session, and the API rejects any side over 2000 px once a
 * request holds many of them; keep both sides under it with room for rounding.
 */
const MAX_IMAGE_WIDTH = 1600
const MAX_IMAGE_HEIGHT = 1960
const MAX_FULL_PAGE_HEIGHT = 8000
/**
 * The compositor's texture limit, in device pixels: past it, a full-page capture repeats
 * the page instead of continuing it.
 */
const MAX_CAPTURE_PIXELS = 16_384
/** First visits can compile the route on demand, which takes a while on large apps. */
const NAVIGATION_TIMEOUT_MS = 30_000
const RELOAD_TIMEOUT_MS = 10_000
/** Media queries, layout, and lazy content settling after a viewport change. */
const SETTLE_MS = 400
/** Restoring the viewport resizes the page asynchronously; how long to wait for its width. */
const RESIZE_WAIT_MS = 500
const ESC = '\u001b'
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\u0007]*(?:\u0007|${ESC}\\\\)`, 'g')

/**
 * Records the scroll offsets of an element's ancestors (nested scrollers and the page)
 * and returns a function that puts them back. Page JavaScript; its result is never read.
 */
const SAVE_SCROLL = `function () {
  const saved = []
  for (let node = this.parentElement; node; node = node.parentElement) {
    saved.push([node, node.scrollLeft, node.scrollTop])
  }
  return () => {
    for (const [node, left, top] of saved) node.scrollTo({ left, top, behavior: 'instant' })
  }
}`

export interface Screenshot {
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  viewportWidth: number
}

export interface ScreenshotOptions {
  selector?: string
  width?: number
  fullPage?: boolean
  /** For the user rather than the agent: a PNG at the display's own resolution, uncapped. */
  fullResolution?: boolean
  /**
   * With `selector`: frame the element the way an earlier crop of it was framed (see
   * `matchingArea`) rather than with the agent's margin.
   */
  matching?: { area: Rect; element: Rect }
  /** Instead of a selector: this part of the page (page coordinates, CSS pixels), for Gui */
  area?: Rect
}

/** A screenshot of part of the page, and which part (page coordinates, CSS pixels). */
export interface FramedScreenshot extends Screenshot {
  area: Rect
}

export interface PreviewToolsDeps {
  wc: WebContents
  inspector: Inspector
  problems: Problems
  /**
   * Inspects a node with its source path relative to the repo root (resolving a monorepo
   * app's paths against its own folder first), without the screenshot.
   */
  inspectNode: (backendNodeId: number) => Promise<ElementContext>
  devOrigin: () => string | null
  /** Current preview URL, or null when nothing is loaded */
  currentUrl: () => string | null
  navigate: (url: string) => Promise<void>
  logs: () => string
  /** How large the page is drawn in the user's device frame; 1 without one (viewport.ts) */
  viewScale: () => number
  /** Inside the inspector's lock: puts the user's viewport (device frame or none) back */
  restoreViewport: () => Promise<void>
}

interface LayoutMetrics {
  cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
  cssContentSize: { width: number; height: number }
}

interface Clip {
  x: number
  y: number
  width: number
  height: number
}

function withTimeout<T>(promise: Promise<T>, message: string, ms: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** What the agent can do with the live preview: look at it, measure it, read its errors. */
export class PreviewTools {
  constructor(private readonly deps: PreviewToolsDeps) {}

  /**
   * Captures the preview as the user sees it, at the page's CSS size even when a device
   * frame draws it smaller. `width` temporarily emulates that viewport width (the user sees
   * it briefly) so the agent can check responsive layouts. Runs alone so parallel calls
   * don't fight over the emulated width, and without our highlight overlay.
   */
  async screenshot(options: ScreenshotOptions): Promise<FramedScreenshot> {
    this.assertLoaded()
    return this.deps.inspector.exclusive((session) =>
      session.withoutHighlight(() => this.capture(session, options)),
    )
  }

  /** Computed styles, box, and source location for the first element matching `selector`. */
  async inspect(selector: string): Promise<Omit<ElementContext, 'screenshot'>> {
    this.assertLoaded()
    const backendNodeId = await this.deps.inspector.querySelector(selector)
    const { screenshot: _screenshot, ...element } = await this.deps.inspectNode(backendNodeId)
    return element
  }

  console() {
    return {
      url: this.deps.currentUrl(),
      messages: this.deps.problems.recentConsole(),
      problems: this.deps.problems.list(),
    }
  }

  async navigate(path: string) {
    const base = this.deps.devOrigin()
    if (!base || !isLoopback(base)) throw new Error('The dev server is not running')
    const url = new URL(path, base)
    if (url.origin !== new URL(base).origin || !/^https?:$/.test(url.protocol)) {
      throw new Error('Only paths on the dev server can be opened')
    }
    await withTimeout(
      this.deps.navigate(url.toString()),
      `${url} didn't finish loading within ${NAVIGATION_TIMEOUT_MS / 1000}s; it may still be compiling (check dev_server_logs)`,
      NAVIGATION_TIMEOUT_MS,
    )
    await sleep(300)
    return this.deps.currentUrl()
  }

  async reload() {
    this.assertLoaded()
    const { wc } = this.deps
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        wc.off('did-stop-loading', done)
        resolve()
      }
      const timer = setTimeout(done, RELOAD_TIMEOUT_MS)
      wc.on('did-stop-loading', done)
      wc.reload()
    })
    return this.deps.currentUrl()
  }

  logs(lines: number) {
    const text = this.deps.logs().replace(ANSI, '').replace(/\r\n?/g, '\n')
    return text.split('\n').slice(-lines).join('\n')
  }

  /** The tools only ever act on the user's own local app, never a page it linked to. */
  private assertLoaded() {
    const url = this.deps.currentUrl()
    if (!url) throw new Error('The preview has no page loaded yet')
    if (!isLoopback(url)) throw new Error('The preview is not showing the local dev server')
  }

  /** Runs inside the inspector's lock; must only use `session` for node lookups. */
  private async capture(
    session: InspectorSession,
    options: ScreenshotOptions,
  ): Promise<FramedScreenshot> {
    const initial = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
    const width = options.width ? Math.round(Math.min(Math.max(options.width, 240), 3840)) : null
    let scrolled = false
    let restoreScrollers: (() => Promise<void>) | null = null
    try {
      // Inside the try: an override that times out may still apply, and must be cleared.
      if (width) await this.emulateWidth(width, initial.cssLayoutViewport.clientHeight)
      const metrics = width ? await this.cmd<LayoutMetrics>('Page.getLayoutMetrics') : initial
      const viewportWidth = metrics.cssLayoutViewport.clientWidth
      const dpr = await this.devicePixelRatio()
      let clip: Clip
      let visible = visibleRect(metrics)
      if (options.selector) {
        const backendNodeId = await session.querySelector(options.selector)
        restoreScrollers = await this.saveScroll(backendNodeId).catch(() => null)
        scrolled = true
        await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
        const fresh = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
        visible = visibleRect(fresh)
        const { model } = await this.cmd<{ model: { border: number[] } }>('DOM.getBoxModel', {
          backendNodeId,
        }).catch(() => {
          throw new Error(`${options.selector} isn't rendered (it has no layout box)`)
        })
        const xs = [model.border[0], model.border[2], model.border[4], model.border[6]]
        const ys = [model.border[1], model.border[3], model.border[5], model.border[7]]
        const element = {
          x: Math.min(...xs) + fresh.cssVisualViewport.pageX,
          y: Math.min(...ys) + fresh.cssVisualViewport.pageY,
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        }
        clip = options.matching ? matchingArea(options.matching, element) : around(element, 16)
      } else if (options.area) {
        clip = options.area
      } else if (options.fullPage) {
        const maxHeight = options.fullResolution
          ? Math.floor(MAX_CAPTURE_PIXELS / dpr)
          : MAX_FULL_PAGE_HEIGHT
        clip = {
          x: 0,
          y: 0,
          width: metrics.cssContentSize.width,
          height: Math.min(metrics.cssContentSize.height, maxHeight),
        }
      } else {
        clip = visible
      }
      const scale = options.fullResolution
        ? 1
        : Math.min(1, MAX_IMAGE_WIDTH / (clip.width * dpr), MAX_IMAGE_HEIGHT / (clip.height * dpr))
      const jpeg = !options.fullResolution && options.fullPage === true && !options.selector
      const { data } = await this.cmd<{ data: string }>('Page.captureScreenshot', {
        format: jpeg ? 'jpeg' : 'png',
        quality: jpeg ? 80 : undefined,
        clip: { ...clip, scale },
        // Off-screen parts come back blank without it, but it resizes the view for the
        // capture, which can reflow `vh` layouts; only when the clip leaves the viewport.
        // (An emulated viewport larger than the view, or drawn smaller in a device frame,
        // isn't cropped: Chromium sizes the surface to the clip for the capture.)
        captureBeyondViewport: !contains(visible, clip),
        fromSurface: true,
      })
      return {
        data,
        mimeType: jpeg ? 'image/jpeg' : 'image/png',
        width: Math.round(clip.width * scale * dpr),
        height: Math.round(clip.height * scale * dpr),
        viewportWidth,
        area: clip,
      }
    } finally {
      // Nested scrollers first, in the layout their offsets were recorded in.
      await restoreScrollers?.().catch(() => undefined)
      if (width) await this.deps.restoreViewport().catch(() => undefined)
      if (width || scrolled) await this.restoreWindowScroll(initial).catch(() => undefined)
    }
  }

  /** In the user's view as it is, drawn at their device frame's scale (see viewport.ts). */
  private async emulateWidth(width: number, height: number) {
    await this.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: width < 768,
      scale: this.deps.viewScale(),
      dontSetVisibleSize: true,
    })
    await sleep(SETTLE_MS)
  }

  /** Lets the agent's capture scroll an element into view without moving the user's page. */
  private async saveScroll(backendNodeId: number) {
    const { object } = await this.cmd<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId,
    })
    try {
      const { result } = await this.cmd<{ result: { objectId?: string } }>(
        'Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration: SAVE_SCROLL },
      )
      const restore = result.objectId
      if (!restore) return null
      return async () => {
        try {
          await this.cmd('Runtime.callFunctionOn', {
            objectId: restore,
            functionDeclaration: 'function () { this() }',
          })
        } finally {
          void this.cmd('Runtime.releaseObject', { objectId: restore }).catch(() => undefined)
        }
      }
    } finally {
      void this.cmd('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined)
    }
  }

  /** The page scroll as it was before the capture; emulation can clamp it, scrolling moves it. */
  private async restoreWindowScroll(before: LayoutMetrics) {
    let now = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
    for (
      let waited = 0;
      waited < RESIZE_WAIT_MS &&
      now.cssLayoutViewport.clientWidth !== before.cssLayoutViewport.clientWidth;
      waited += 50
    ) {
      await sleep(50)
      now = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
    }
    const { pageX, pageY } = before.cssLayoutViewport
    if (
      Math.abs(now.cssLayoutViewport.pageX - pageX) < 1 &&
      Math.abs(now.cssLayoutViewport.pageY - pageY) < 1
    ) {
      return
    }
    await this.cmd('Runtime.evaluate', {
      expression: `scrollTo({ left: ${Number(pageX)}, top: ${Number(pageY)}, behavior: 'instant' })`,
    })
  }

  private async devicePixelRatio() {
    const { result } = await this.cmd<{ result: { value: unknown } }>('Runtime.evaluate', {
      expression: 'devicePixelRatio',
      returnByValue: true,
    })
    const value = Number(result.value)
    return Number.isFinite(value) && value > 0 && value <= 4 ? value : 1
  }

  /** Inspector bounds every CDP command. */
  private cmd<T = unknown>(method: string, params?: Record<string, unknown>) {
    return this.deps.inspector.command<T>(method, params)
  }
}

/** The part of the page currently on screen, in page coordinates. */
function visibleRect(metrics: LayoutMetrics): Clip {
  const { pageX, pageY, clientWidth, clientHeight } = metrics.cssVisualViewport
  return { x: pageX, y: pageY, width: clientWidth, height: clientHeight }
}

function contains(outer: Clip, inner: Clip) {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  )
}

/** The element with `pad` around it; the page has nothing above or left of its origin. */
function around(element: Clip, pad: number): Clip {
  return {
    x: Math.max(0, element.x - pad),
    y: Math.max(0, element.y - pad),
    width: element.width + pad * 2,
    height: element.height + pad * 2,
  }
}

function union(a: Clip, b: Clip): Clip {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

const area = (clip: Clip) => clip.width * clip.height

/**
 * Where to capture `element` so the image lines up with an earlier crop of it (`before`,
 * the inspector's pick crop). The same size: the same area, moved with the element, so a
 * layout shift around it doesn't show as a change. Resized: the area both the old crop and
 * the new box (with the crop's margin) cover, where it changed in place. Moved far as well
 * as resized, that area would mostly be page, so the element is framed on its own.
 */
export function matchingArea(before: { area: Rect; element: Rect }, element: Clip): Clip {
  const sameSize =
    Math.abs(element.width - before.element.width) <= 1 &&
    Math.abs(element.height - before.element.height) <= 1
  if (sameSize) {
    const dx = element.x - before.element.x
    const dy = element.y - before.element.y
    return {
      ...before.area,
      x: Math.max(0, before.area.x + dx),
      y: Math.max(0, before.area.y + dy),
    }
  }
  const framed = around(element, CROP_MARGIN)
  const both = union(before.area, framed)
  return area(both) > 4 * Math.max(area(before.area), area(framed)) ? framed : both
}
