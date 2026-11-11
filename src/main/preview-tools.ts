import type { WebContents } from 'electron'
import {
  CROP_MARGIN,
  type PageRect,
  pagePoint,
  pageRectFromViewport,
  viewportRectFrom,
} from '../shared/coords'
import type { ElementContext, Rect, RulerGuide, StartCommandInput } from '../shared/types'
import { base64Bytes, type DecodedImage, encodeWithin, MAX_AGENT_IMAGE_BYTES } from './agent-image'
import { alignGuides, describeAlignment } from './guide-alignment'
import type { ForcedState, Inspector, InspectorSession } from './inspector'
import { isLoopback } from './loopback'
import { type BeforeInput, PreviewInteractions } from './preview-interactions'
import { type MotionRequest, planMotion } from './preview-motion-format'
import type { Problems } from './problems'
import { navigationTarget } from './public-address'
import { logTail } from './startup'
import type { VariationsInput } from './variations'

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
/** The longest preview_wait waits, for anything */
export const MAX_WAIT_MS = 15_000
/** How often preview_wait looks again */
const WAIT_POLL_MS = 150
/** Media queries, layout, and lazy content settling after a viewport change. */
export const SETTLE_MS = 400
/** Restoring the viewport resizes the page asynchronously; how long to wait for its width. */
const RESIZE_WAIT_MS = 500

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
  /** Where a tall capture was cut (CSS pixels from its top), or null when it wasn't */
  cutAt: number | null
  /** The height it would have had uncut, in CSS pixels */
  fullHeight: number
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

/** The page the tools act on: the user's app, or a website the agent opened (website.ts). */
export interface PageDeps {
  /**
   * `app`: the user's app on its local dev server (or a canvas frame). `website`: a public
   * website, in its own signed-out session, where typing into password and payment fields is
   * refused.
   */
  kind: 'app' | 'website'
  wc: WebContents
  inspector: Inspector
  /**
   * Inspects a node with its source path relative to the repo root (resolving a monorepo
   * app's paths against its own folder first), without the screenshot. A website has none.
   */
  inspectNode: (backendNodeId: number) => Promise<ElementContext>
  /** How large the page is drawn in the user's device frame; 1 without one (viewport.ts) */
  viewScale: () => number
  /** Inside the inspector's lock: puts the user's viewport (device frame or none) back */
  restoreViewport: () => Promise<void>
  /**
   * Runs `run` with the preview showing a viewport `width` CSS px wide, the way the user would
   * pick one: it resizes there first, and back a moment after (agent-viewport.ts). Runs `run`
   * as it is when it can't (the preview is out of sight). The user's app only.
   */
  atWidth?: <T>(width: number, run: () => Promise<T>) => Promise<T>
  /** Inside the inspector's lock: the width the page's viewport lays out at; null filling the view */
  shownWidth?: () => number | null
  /**
   * preview_point: a walkthrough step drawn over the page (null node: a caption on its own).
   * False when the user can't see it: the preview is hidden, or they're picking.
   */
  guide: (node: number | null, caption: string | null) => boolean
  /** Takes the agent's visible pointer to each input's target first */
  guideInput: BeforeInput
  /** Something that happened on the page since the last tool, to tell the agent once */
  notice?: () => string | null
  /**
   * False once the project opening these tools belong to is closed or replaced: a call still
   * running then stops before it touches the next project's preview.
   */
  live?: () => boolean
  /**
   * `app` only: the origins the user's app is at (its dev server's, or a canvas's own). A page
   * elsewhere, even on this machine (another project's server, a database UI), isn't theirs.
   */
  origins?: () => string[]
  /** `app` only: what to tell the agent when the preview shows none of `origins` */
  elsewhere?: string
}

/** What the agent learns from preview_inspect: the element, its box in page CSS pixels. */
export interface InspectedElement {
  url: string
  viewport: { width: number; height: number }
  tag: string
  /** A selector React gave it, when it says more than the tag */
  selector?: string
  text: string
  attributes: Record<string, string>
  outerHTML: string
  /** Page (document) CSS pixels, the space guides and fullPage screenshots use */
  pageBox: PageRect
  styles: Record<string, string>
  /** For each state asked for, the styles that differ in it ("initial": back to the default) */
  states?: Partial<Record<ForcedState, Record<string, string>>>
  componentStack: string[]
  source: ElementContext['source']
}

/** The website the agent can open in the preview in place of the app (website.ts). */
export interface WebsiteHost {
  /** The website showing in the preview, or null when the preview shows the app */
  shown: () => PageTools | null
  /** Opens `url` (http or https, public) in the website, opening it first; where it landed */
  open: (url: URL) => Promise<string>
  /**
   * The agent going back to the app: the website closes and its session is cleared, and any
   * note that the user went back is forgotten (the agent is on the app now, as it asked)
   */
  close: () => void
  /**
   * Why the website closed under the agent (the user went back to their app), once, for its
   * next page tool to say; null otherwise
   */
  takeClosedNote: () => string | null
}

export interface PreviewToolsDeps extends Omit<PageDeps, 'kind'> {
  problems: Problems
  devOrigin: () => string | null
  /** Current preview URL, or null when nothing is loaded */
  currentUrl: () => string | null
  navigate: (url: string) => Promise<void>
  /**
   * On a canvas, where the only pages are its frames: opens the frame `url` names (on the
   * canvas's own address), or throws; where it landed. Absent in a project.
   */
  openFrame?: (url: URL) => Promise<string>
  logs: () => string
  /** The dev server's state in a few lines (`describeServer`) */
  serverStatus: () => string
  /** Gets the app running again, from the top, and waits to see; what happened */
  restartServer: () => Promise<string>
  /**
   * Starts the app with `input` from now on once the user approves it (null: what Gui
   * detects again), and waits to see; what happened
   */
  setStartCommand: (input: StartCommandInput | null) => Promise<string>
  /** preview_variations: shows the set's bar and version (variations.ts); what happened */
  variations: (input: VariationsInput) => Promise<string>
  website: WebsiteHost
  guides: GuidesHost
}

/** The user's ruler guides over the app's preview (guides.ts), for preview_guides. */
export interface GuidesHost {
  /** The project's guides, in page CSS pixels */
  list: () => RulerGuide[]
  /** The rulers are on, so the user sees them */
  shown: () => boolean
  /**
   * Adds and removes guides like the user's own, saved with them; adding turns the rulers on.
   * How many changed, and whether the rulers came on.
   */
  change: (change: GuidesChange) => {
    added: number
    removed: number
    full: boolean
    turnedOn: boolean
  }
}

export interface GuidesChange {
  add: RulerGuide[]
  remove: RulerGuide[]
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

/** What preview_wait waits for: an element, text, either going away, or just time. */
export interface WaitOptions {
  selector?: string
  text?: string
  gone?: boolean
  /** How long to wait at most (or, with nothing to wait for, how long), in ms */
  ms?: number
}

/**
 * Resolves when `wc` next stops loading or moves within its page (history.pushState, a hash),
 * or after `ms`.
 */
function settled(wc: WebContents, ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      wc.off('did-stop-loading', done)
      wc.off('did-navigate-in-page', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    wc.on('did-stop-loading', done)
    wc.on('did-navigate-in-page', done)
  })
}

/** Resolves when `wc` next stops loading, or after `ms`. */
function stoppedLoading(wc: WebContents, ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      wc.off('did-stop-loading', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    wc.on('did-stop-loading', done)
  })
}

/** About how long a walkthrough caption takes to read, and the pointer to land. */
const readingTime = (caption: string | null) =>
  caption ? Math.min(8000, 1400 + caption.length * 45) : 900

/**
 * What the agent can do with a page in the preview: read it, interact, point things out and
 * screenshot it. The user's app (PreviewTools) and a website the agent opened (website.ts).
 */
export class PageTools {
  readonly interactions: PreviewInteractions
  /** How many of the agent's inputs are reaching the page now (`input`) */
  private inputs = 0

  constructor(protected readonly page: PageDeps) {
    this.interactions = new PreviewInteractions(
      page.inspector,
      () => this.assertLoaded(),
      // While the walkthrough's pointer glides there, what reaches the page is the user's.
      async (at, click) => {
        this.inputs--
        try {
          await page.guideInput(at, click)
        } finally {
          this.inputs++
        }
        // The glide takes a moment: the page may have gone, or the project with it.
        this.assertLoaded()
      },
      page.kind === 'website',
    )
  }

  /**
   * The agent's clicks, keys, typing and scrolling (`interactions`), marked as its own while
   * they reach the page (`inputting`), so Gui doesn't take them for the user's: its Esc doesn't
   * close a canvas frame, nor its click hide the chat.
   */
  async input<T>(action: (interactions: PreviewInteractions) => Promise<T>): Promise<T> {
    this.inputs++
    try {
      return await action(this.interactions)
    } finally {
      this.inputs--
    }
  }

  /** The agent's input (`input`) is reaching the page right now */
  get inputting() {
    return this.inputs > 0
  }

  get kind() {
    return this.page.kind
  }

  /** The page's address now; empty once it closed (the user went back mid-tool) */
  url() {
    return this.page.wc.isDestroyed() ? '' : this.page.wc.getURL()
  }

  title() {
    return this.page.wc.isDestroyed() ? '' : this.page.wc.getTitle()
  }

  /** What happened on the page since the last tool (a blocked form post), once; or null */
  takeNotice() {
    return this.page.notice?.() ?? null
  }

  /**
   * Points the user at `selector` (scrolled into view) with `caption`, then waits about as
   * long as reading it takes, so a walkthrough goes at the user's pace.
   */
  async point(selector: string | undefined, caption: string | undefined) {
    this.assertLoaded()
    const node = selector ? await this.interactions.locate(selector) : null
    this.assertLoaded()
    const text = caption?.replace(/\s+/g, ' ').trim() || null
    if (!this.page.guide(node, text))
      return "Not shown: the user isn't looking at the preview right now (it's hidden, or they're in design mode)."
    await sleep(readingTime(text))
    this.assertLive()
    return text ? 'Shown, and the user has had time to read it.' : 'Shown.'
  }

  /**
   * Captures the preview as the user sees it, at the page's CSS size even when a device
   * frame draws it smaller. `width` checks a responsive layout: the preview resizes into
   * that viewport as the user's pick would (`atWidth`), or, where it can't, the width is
   * emulated for the capture alone. Runs alone so parallel calls don't fight over the
   * emulated width, and without our highlight overlay.
   */
  async screenshot(options: ScreenshotOptions): Promise<FramedScreenshot> {
    this.assertLoaded()
    // An edit that just landed can reload the page (Astro, or HMR giving up); mid-reload
    // it's blank, so wait for the new page to load and paint.
    if (this.page.wc.isLoading()) {
      await stoppedLoading(this.page.wc, RELOAD_TIMEOUT_MS)
      await sleep(300)
      this.assertLoaded()
    }
    const width = options.width ? Math.round(Math.min(Math.max(options.width, 240), 3840)) : null
    const shoot = () =>
      this.page.inspector.exclusive((session) =>
        session.withoutHighlight(() => {
          this.assertLoaded()
          return this.capture(session, options, width)
        }),
      )
    const shot = await (width && this.page.atWidth ? this.page.atWidth(width, shoot) : shoot())
    this.assertLive()
    return options.fullResolution ? shot : await withinBytes(shot)
  }

  /**
   * Computed styles, box, and source location for the first element matching `selector`, as
   * the agent reads it: its box in page CSS pixels, nothing it can't use.
   */
  async inspect(selector: string, forced: ForcedState[] = []): Promise<InspectedElement> {
    this.assertLoaded()
    const backendNodeId = await this.page.inspector.querySelector(selector)
    this.assertLoaded()
    const element = await this.page.inspectNode(backendNodeId)
    this.assertLoaded()
    const pageBox = await this.pageBox(backendNodeId)
    const states: InspectedElement['states'] = {}
    for (const state of forced) {
      const styles = await this.page.inspector.stateStyles(backendNodeId, state)
      this.assertLoaded()
      states[state] = changedStyles(element.styles, styles)
    }
    return {
      url: element.url,
      viewport: element.viewport,
      tag: element.tag,
      ...(element.selector !== element.tag ? { selector: element.selector } : {}),
      text: element.text,
      attributes: element.attributes,
      outerHTML: element.outerHTML,
      pageBox,
      styles: element.styles,
      componentStack: element.componentStack,
      source: element.source,
      ...(forced.length ? { states } : {}),
    }
  }

  /**
   * preview_wait: until `selector` and/or `text` shows (or, `gone`, stops showing), up to
   * `ms`; with neither, just `ms`. What happened, in a line.
   */
  async wait({ selector, text, gone = false, ms }: WaitOptions): Promise<string> {
    this.assertLoaded()
    const started = Date.now()
    if (selector === undefined && text === undefined) {
      const wait = Math.min(ms ?? 1000, MAX_WAIT_MS)
      await sleep(wait)
      this.assertLive()
      return `Waited ${wait}ms.`
    }
    const limit = Math.min(ms ?? 5000, MAX_WAIT_MS)
    const what = [
      selector !== undefined ? `\`${selector}\`` : null,
      text !== undefined ? JSON.stringify(text) : null,
    ]
      .filter(Boolean)
      .join(' with ')
    for (;;) {
      const present = await this.interactions.present(selector, text)
      const waited = Date.now() - started
      if (present !== null && present !== gone)
        return `${what} ${gone ? 'went away' : 'showed'} after ${waited}ms.`
      if (waited >= limit)
        return `${what} ${gone ? 'still showed' : "didn't show"} after ${limit}ms.`
      await sleep(Math.min(WAIT_POLL_MS, limit - waited))
      this.assertLoaded()
    }
  }

  /**
   * preview_back: the page before this one in the preview's history, when it's one these tools
   * may act on (the app at its own address, or the website); where it is after.
   */
  async back() {
    this.assertLoaded()
    const { wc } = this.page
    const history = wc.navigationHistory
    const index = history.getActiveIndex()
    const previous = index > 0 ? history.getEntryAtIndex(index - 1) : null
    if (!previous || this.refusal(previous.url))
      throw new Error(
        this.page.kind === 'website'
          ? 'Nothing earlier on this website to go back to.'
          : "Nothing earlier in the user's app to go back to.",
      )
    const moved = settled(wc, NAVIGATION_TIMEOUT_MS)
    history.goBack()
    await moved
    // An in-page move renders after the event; a load paints after it stops.
    await sleep(300)
    this.assertLive()
    return { url: this.url(), loading: !wc.isDestroyed() && wc.isLoading() }
  }

  /** Reloads the page; where it is after, and whether it's still loading after RELOAD_TIMEOUT_MS. */
  async reload() {
    this.assertLoaded()
    const { wc } = this.page
    const loaded = stoppedLoading(wc, RELOAD_TIMEOUT_MS)
    wc.reload()
    await loaded
    this.assertLive()
    return {
      url: wc.isDestroyed() ? '' : wc.getURL(),
      loading: !wc.isDestroyed() && wc.isLoading(),
    }
  }

  /** The element's border box, in page CSS pixels: its viewport box and the scroll read together. */
  private pageBox(backendNodeId: number) {
    return this.page.inspector.exclusive(async () => {
      this.assertLoaded()
      const [{ model }, metrics] = await Promise.all([
        this.cmd<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId }).catch(
          () => ({ model: { border: [0, 0, 0, 0, 0, 0, 0, 0] } }),
        ),
        this.cmd<LayoutMetrics>('Page.getLayoutMetrics'),
      ])
      const xs = [model.border[0], model.border[2], model.border[4], model.border[6]]
      const ys = [model.border[1], model.border[3], model.border[5], model.border[7]]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const box = viewportRectFrom({
        x,
        y,
        width: Math.max(...xs) - x,
        height: Math.max(...ys) - y,
      })
      const { pageX, pageY } = metrics.cssVisualViewport
      const page = pageRectFromViewport(box, pagePoint(pageX, pageY))
      // Whole pixels read as well and cost fewer tokens.
      return pageRectFromViewport(
        viewportRectFrom({
          x: Math.round(page.x),
          y: Math.round(page.y),
          width: Math.round(page.width),
          height: Math.round(page.height),
        }),
        pagePoint(0, 0),
      )
    })
  }

  /** The project these tools belong to is still the one open. */
  protected assertLive() {
    if (this.page.live && !this.page.live())
      throw new Error('The project was closed or replaced in this tab; nothing more was done.')
  }

  /**
   * The app's tools only ever act on the user's own app at its own origin, never a page it
   * linked to (even one on this machine); a website's only on a public web page, never this
   * machine. Checked before and after each step that waits.
   */
  protected assertLoaded() {
    this.assertLive()
    const url = this.url()
    if (!url) throw new Error('The preview has no page loaded yet')
    const refused = this.refusal(url)
    if (refused) throw new Error(refused)
  }

  /** Why these tools mustn't act on a page at `url`, or null when they may. */
  private refusal(url: string): string | null {
    if (this.page.kind === 'website')
      return !/^https?:/i.test(url) || isLoopback(url) ? 'The website has no page open' : null
    const elsewhere = this.page.elsewhere ?? 'The preview is not showing the local dev server'
    if (!isLoopback(url)) return elsewhere
    const origins = this.page.origins?.()
    return origins && !origins.includes(new URL(url).origin) ? elsewhere : null
  }

  /** Runs inside the inspector's lock; must only use `session` for node lookups. */
  private async capture(
    session: InspectorSession,
    options: ScreenshotOptions,
    width: number | null,
  ): Promise<FramedScreenshot> {
    const initial = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
    // None when the preview resized into a viewport that wide (`atWidth`).
    const emulated = width !== null && this.page.shownWidth?.() !== width ? width : null
    let scrolled = false
    let restoreScrollers: (() => Promise<void>) | null = null
    try {
      // Inside the try: an override that times out may still apply, and must be cleared.
      if (emulated) await this.emulateWidth(emulated, initial.cssLayoutViewport.clientHeight)
      const metrics = emulated ? await this.cmd<LayoutMetrics>('Page.getLayoutMetrics') : initial
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
        clip = { x: 0, y: 0, ...metrics.cssContentSize }
      } else {
        clip = visible
      }
      // A tall element is cut like a full page: past this, the image is too squeezed to read
      // (or, at full resolution, the compositor repeats the page).
      const fullHeight = clip.height
      const maxHeight = options.fullResolution
        ? Math.floor(MAX_CAPTURE_PIXELS / dpr)
        : MAX_FULL_PAGE_HEIGHT
      if (!options.area && clip.height > maxHeight) clip = { ...clip, height: maxHeight }
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
        cutAt: clip.height < fullHeight ? Math.round(clip.height) : null,
        fullHeight,
      }
    } finally {
      // Nested scrollers first, in the layout their offsets were recorded in.
      await restoreScrollers?.().catch(() => undefined)
      if (emulated) await this.page.restoreViewport().catch(() => undefined)
      if (emulated || scrolled) await this.restoreWindowScroll(initial).catch(() => undefined)
    }
  }

  /** In the user's view as it is, drawn at their device frame's scale (see viewport.ts). */
  private async emulateWidth(width: number, height: number) {
    await this.cmd('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: width < 768,
      scale: this.page.viewScale(),
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
    return this.page.inspector.command<T>(method, params)
  }
}

/**
 * A screenshot the agent can take in: one past MAX_AGENT_IMAGE_BYTES (a detailed page at a
 * high pixel ratio) is encoded again as a JPEG, smaller if it must be.
 */
export async function withinBytes<T extends Screenshot>(
  shot: T,
  decode: (data: Buffer) => DecodedImage | Promise<DecodedImage> = async (data) =>
    (await import('electron')).nativeImage.createFromBuffer(data),
): Promise<T> {
  if (base64Bytes(shot.data) <= MAX_AGENT_IMAGE_BYTES) return shot
  const image = await decode(Buffer.from(shot.data, 'base64'))
  if (image.isEmpty()) return shot
  const encoded = encodeWithin(image, { png: false })
  return {
    ...shot,
    data: encoded.data.toString('base64'),
    mimeType: encoded.mimeType,
    width: encoded.width,
    height: encoded.height,
  }
}

/**
 * The styles that differ in a forced state from the element's own: changed or added, and
 * those that went back to their default ("initial"), which `styles` leaves out.
 */
export function changedStyles(base: Record<string, string>, state: Record<string, string>) {
  const changed: Record<string, string> = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(state)])) {
    if (base[key] !== state[key]) changed[key] = state[key] ?? 'initial'
  }
  return changed
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

/**
 * The agent's preview tools: the user's app (its page, console, dev server), and the website it
 * opened in the preview instead, when it has (`shown`).
 */
export class PreviewTools extends PageTools {
  constructor(private readonly deps: PreviewToolsDeps) {
    super({ ...deps, kind: 'app' })
  }

  /**
   * The page the page tools act on: the website showing in the preview, or the app. Once,
   * after the user went back to their app themselves, it says so rather than act on the app.
   */
  shown(): PageTools {
    this.assertLive()
    const closed = this.deps.website.takeClosedNote()
    if (closed) throw new Error(closed)
    return this.deps.website.shown() ?? this
  }

  /**
   * preview_navigate: a path, or an address on the app (on a canvas, a frame's page), closing
   * any website. Where the preview ended up. Websites open with `openWebsite`, which asks.
   */
  async navigate(input: string): Promise<string> {
    this.assertLive()
    const target = navigationTarget(input, this.deps.devOrigin())
    if (target.kind === 'website')
      throw new Error(
        this.deps.openFrame
          ? 'On a canvas, open a frame with canvas_open_frame; look at websites with canvas_screenshot_url.'
          : "That isn't the user's app. Open websites with preview_open_website.",
      )
    this.deps.website.close()
    const { url } = target
    const { openFrame } = this.deps
    if (openFrame) {
      const opened = await withTimeout(
        openFrame(url),
        `${url} didn't finish loading within ${NAVIGATION_TIMEOUT_MS / 1000}s`,
        NAVIGATION_TIMEOUT_MS,
      )
      this.assertLive()
      return opened
    }
    await withTimeout(
      this.deps.navigate(url.toString()),
      `${url} didn't finish loading within ${NAVIGATION_TIMEOUT_MS / 1000}s; it may still be compiling (check dev_server_logs)`,
      NAVIGATION_TIMEOUT_MS,
    )
    await sleep(300)
    this.assertLive()
    return this.deps.currentUrl() ?? url.toString()
  }

  /**
   * preview_open_website: a full http(s) address elsewhere, in its own signed-out session over
   * the app. Where it landed.
   */
  async openWebsite(input: string): Promise<string> {
    this.assertLive()
    if (!/^https?:\/\//i.test(input.trim()))
      throw new Error("Pass a website's full address, starting with https://.")
    const target = navigationTarget(input, this.deps.devOrigin())
    if (target.kind === 'app')
      throw new Error("That's the user's app. Open its pages with preview_navigate.")
    const opened = await this.deps.website.open(target.url)
    this.assertLive()
    return opened
  }

  console() {
    this.assertLive()
    return {
      url: this.deps.currentUrl(),
      messages: this.deps.problems.recentConsole(),
      problems: this.deps.problems.list(),
    }
  }

  serverStatus() {
    this.assertLive()
    return this.deps.serverStatus()
  }

  async restartServer() {
    this.assertLive()
    const outcome = await this.deps.restartServer()
    this.assertLive()
    return outcome
  }

  async setStartCommand(input: StartCommandInput | null) {
    this.assertLive()
    const outcome = await this.deps.setStartCommand(input)
    this.assertLive()
    return outcome
  }

  variations(input: VariationsInput) {
    this.assertLive()
    return this.deps.variations(input)
  }

  /**
   * preview_guides: changes the user's guides as asked, then reads them with the element edges
   * that nearly line up with them. On the user's app only.
   */
  async guides(change: GuidesChange) {
    this.assertLoaded()
    const lines: string[] = []
    if (change.add.length || change.remove.length) {
      const { added, removed, full, turnedOn } = this.deps.guides.change(change)
      const done = [added ? `added ${added}` : null, removed ? `removed ${removed}` : null].filter(
        Boolean,
      )
      lines.push(done.length ? `Guides ${done.join(' and ')}.` : 'No guide changed.')
      if (full) lines.push("Some weren't added: the project has as many guides as it keeps.")
      if (turnedOn) {
        lines.push('The rulers were off; they are on now, so the user sees the guides.')
        // The page moves over for the rulers, which can reflow it.
        await sleep(SETTLE_MS)
        this.assertLoaded()
      }
    }
    const guides = this.deps.guides.list()
    if (!guides.length) {
      lines.push(
        'The project has no guides. Pass `add` to place some, or ask the user to drag them out of the rulers (View → Rulers, ⇧R).',
      )
      return lines.join('\n')
    }
    if (!this.deps.guides.shown())
      lines.push("The rulers are off, so the user doesn't see these guides now.")
    const measured = await this.interactions.boxes()
    this.assertLive()
    const scroll = pagePoint(measured.scroll.x, measured.scroll.y)
    const boxes = measured.boxes.map(({ selector, label, ...rect }) => ({
      selector,
      label,
      rect: pageRectFromViewport(viewportRectFrom(rect), scroll),
    }))
    lines.push(describeAlignment(guides, alignGuides(guides, boxes), measured))
    return lines.join('\n')
  }

  /**
   * preview_motion: plays motion in the app and films it (preview-motion.ts, loaded when used:
   * it needs Electron's images, which the unit tests run without).
   */
  async motion(request: MotionRequest) {
    const plan = planMotion(request)
    const { filmMotion } = await import('./preview-motion')
    return filmMotion(
      {
        wc: this.deps.wc,
        inspector: this.deps.inspector,
        assertLoaded: () => this.assertLoaded(),
        input: (action) => this.input(action),
      },
      plan,
    )
  }

  /** The dev server's last `lines` lines, cut to fit (logTail). */
  logs(lines: number) {
    this.assertLive()
    return logTail(this.deps.logs(), lines)
  }
}
