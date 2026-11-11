import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeTheme, type WebContents } from 'electron'
import {
  CROP_MARGIN,
  pageFromViewport,
  pagePoint,
  pageRectFromViewport,
  viewportPointFrom,
  viewportRect,
  viewRectFromViewport,
} from '../shared/coords'
import { ACCENT, FILL } from '../shared/theme'
import type { ElementContext, Point, Rect, SourceLocation } from '../shared/types'
import { awaitCapture } from './page-capture'
import { normalizeSourcePath, projectRelativePath, resolveStack } from './source-resolver'

const COMMAND_TIMEOUT_MS = 15_000
/** Gui's accent for the current appearance, as the protocol takes colors. */
function accent() {
  const hex = nativeTheme.shouldUseDarkColors ? ACCENT.dark : ACCENT.light
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  return { r, g, b }
}

/**
 * The picked element's highlight in Gui's accent for the current appearance: the content
 * tinted, the padding lighter, the margin a neutral fill, an accent outline. No label: the
 * composer names the element, and a label would only cover the page around it. (While the
 * user picks, Gui's own overlay draws instead; see picker.ts.)
 */
function highlightConfig() {
  const dark = nativeTheme.shouldUseDarkColors
  const { r, g, b } = accent()
  return {
    showInfo: false,
    showStyles: false,
    showAccessibilityInfo: false,
    contentColor: { r, g, b, a: 0.18 },
    paddingColor: { r, g, b, a: 0.1 },
    marginColor: dark ? FILL.dark : FILL.light,
    borderColor: { r, g, b, a: 1 },
  }
}

/** Properties worth showing a designer or an agent, in reading order. */
const STYLE_KEYS = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'aspect-ratio',
  'margin',
  'padding',
  'flex-direction',
  'flex-wrap',
  'flex',
  'align-items',
  'justify-content',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'white-space',
  'color',
  'background-color',
  'background-image',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'box-shadow',
  'outline',
  'opacity',
  'transform',
  'transition',
  'overflow',
  'object-fit',
  'cursor',
]
/** Computed styles come back as longhands; these fold back into their shorthand. */
const BOX_SHORTHANDS: Record<string, string[]> = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ],
  'border-style': [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
  ],
  'border-color': [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],
  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
}
const DEFAULT_STYLE_VALUES = new Set([
  '',
  'none',
  'normal',
  'auto',
  '0px',
  'rgba(0, 0, 0, 0)',
  'static',
  'visible',
])
/** Initial values that are only noise for one specific property. */
const PROPERTY_DEFAULTS: Record<string, string[]> = {
  'flex-direction': ['row'],
  'flex-wrap': ['nowrap'],
  flex: ['0 1 auto'],
  'text-align': ['start'],
  opacity: ['1'],
  'object-fit': ['fill'],
  transition: ['all', 'all 0s ease 0s'],
  cursor: ['default'],
}
const MAX_HTML = 4000
const REACT_TIMEOUT_MS = 4000

/**
 * Attributes some dev servers put on elements, naming the file (and `line:column`) that
 * wrote them. Read when React has no source for the element.
 */
const SOURCE_ATTRIBUTES = [
  // Astro, for elements written in .astro files; the column is where the opening tag ends.
  { file: 'data-astro-source-file', loc: 'data-astro-source-loc' },
]
/** How many ancestors up the nearest element with source attributes may be. */
const SOURCE_ANCESTORS = 10
/** Bounds the walk from the picked element to the document. */
const MAX_LINEAGE = 64
const MAX_FILE_STACK = 5

/**
 * The only part of extraction that runs as page JavaScript: React's fiber data is
 * reachable nowhere else. Everything it returns is untrusted and validated in main.
 * Plain JS string so bundling can't inject helpers that don't exist in the page.
 */
const REACT_INFO = `async function () {
  const el = this
  const fiberKey = () => Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  // Server-rendered React pages are clickable before hydration attaches fibers.
  const ssr = self.__next_f || self.__NEXT_DATA__ || self.__reactRouterContext || self.__remixContext
  for (let i = 0; ssr && !fiberKey() && i < 30; i++) await new Promise((r) => setTimeout(r, 100))

  const path = []
  for (let node = el; node && node.nodeType === 1 && path.length < 6; node = node.parentElement) {
    let part = node.localName
    if (node.id) { path.unshift(part + '#' + CSS.escape(node.id)); break }
    const parent = node.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.localName === node.localName)
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
    }
    path.unshift(part)
  }

  const internal = /^(InnerLayoutRouter|OuterLayoutRouter|RedirectErrorBoundary|RedirectBoundary|HTTPAccessFallback.*|HTTPAccessErrorBoundary|LoadingBoundary|ErrorBoundary.*|InnerScrollAndFocusHandler|ScrollAndFocusHandler|RenderFromTemplateContext|Router|AppRouter|HotReload|ReactDevOverlay|ServerRoot|Root|DevRootHTTPAccessFallbackBoundary|AppDevOverlay.*|ClientPageRoot|ClientSegmentRoot|SegmentViewNode|SegmentStateProvider|SegmentBoundaryTriggerNode|SegmentTrieNode|MetadataBoundary|ViewportBoundary|OutletBoundary|__next_.*|Suspense|StrictMode|Fragment)$/
  const key = fiberKey()
  const componentStack = []
  let debugStack = null
  let debugSource = null
  if (key) {
    const fiber = el[key]
    for (let f = fiber, steps = 0; f && !debugStack && !debugSource && steps < 50; f = f._debugOwner || null, steps++) {
      if (f._debugStack && typeof f._debugStack.stack === 'string') debugStack = f._debugStack.stack
      if (f._debugSource) debugSource = { fileName: f._debugSource.fileName, lineNumber: f._debugSource.lineNumber, columnNumber: f._debugSource.columnNumber }
    }
    // Owner chain = who rendered this (skips providers and pass-through wrappers).
    // Owners are fibers, or plain { name, env, owner } records for server components.
    const nameOf = (node) => {
      if (typeof node.name === 'string' && node.type === undefined) return node.name
      const type = node.type
      if (typeof type === 'function') return type.displayName || type.name
      if (type && typeof type === 'object' && !type._context && String(type.$$typeof) !== 'Symbol(react.context)') {
        return type.displayName || (type.render && (type.render.displayName || type.render.name)) || (type.type && (type.type.displayName || type.type.name))
      }
      return null
    }
    for (let o = fiber._debugOwner, steps = 0; o && componentStack.length < 6 && steps < 50; o = o._debugOwner || o.owner || null, steps++) {
      const name = nameOf(o)
      if (name && !internal.test(name) && componentStack[componentStack.length - 1] !== name) componentStack.push(name)
    }
  }
  return { selector: path.join(' > '), componentStack, debugStack, debugSource }
}`

/**
 * The nearest component around the element, for the label while picking: what a designer
 * calls it. Cheap and synchronous (it runs per element hovered); untrusted, like REACT_INFO.
 */
const HOVER_NAME = `function () {
  const key = Object.keys(this).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  if (!key) return null
  const internal = /^(Inner|Outer)?LayoutRouter$|Boundary|Router|HotReload|Root$|Segment|Provider$|Context$|^Suspense$|^StrictMode$|^Fragment$|^__next/
  for (let f = this[key].return, steps = 0; f && steps < 40; f = f.return, steps++) {
    const t = f.type
    const name = typeof t === 'function' ? t.displayName || t.name : t && typeof t === 'object' ? t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) : null
    if (name && !internal.test(name)) return name
  }
  return null
}`

/**
 * The smallest element, from this one up, whose box holds all of the area (x, y, width,
 * height in the viewport); null when only the body or the document does. Untrusted: it only
 * chooses which element main then describes over the protocol.
 */
const CONTAINER = `function (x, y, width, height) {
  for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
    if (el === document.body || el === document.documentElement) return null
    const r = el.getBoundingClientRect()
    if (r.left <= x + 1 && r.top <= y + 1 && r.right >= x + width - 1 && r.bottom >= y + height - 1) return el
  }
  return null
}`

interface ReactInfo {
  selector: string
  componentStack: string[]
  debugStack: string | null
  debugSource: { fileName: string; lineNumber: number; columnNumber?: number } | null
}

/** An element's source attributes (see SOURCE_ATTRIBUTES); page data, unverified. */
interface SourceTag {
  file: string
  loc: string | null
}

/** A node the protocol reported while pushing a path to the frontend. */
interface LineageNode {
  parentId: number | undefined
  tag: SourceTag | null
}

interface InspectorEvents {
  /** The debugger session closed; what it set up, such as emulation, went with it. */
  detach: []
  /**
   * The page may not have the emulation last sent any more (a capture cut short, a new
   * document): whatever emulates its viewport (viewport.ts) sends it again.
   */
  emulationLost: []
}

/**
 * What code running inside `Inspector.exclusive` may use. These skip the lock; the
 * public equivalents would wait for it and deadlock.
 */
/** A state preview_inspect can force on an element to read its styles in it. */
export type ForcedState = 'hover' | 'focus' | 'active'

/** The longest a forced state's transitions are waited for. */
const STATE_SETTLE_MAX_MS = 1000

/**
 * How long transitions take to finish, in ms: the longest duration plus its delay, from the
 * computed `transition-duration` and `transition-delay` lists ("0.2s, 300ms").
 */
export function transitionTime(durations = '', delays = '') {
  const times = (list: string) =>
    list.split(',').map((part) => {
      const value = Number.parseFloat(part)
      return Number.isFinite(value) ? value * (part.trim().endsWith('ms') ? 1 : 1000) : 0
    })
  const delay = times(delays)
  const longest = Math.max(
    0,
    ...times(durations).map((ms, i) => ms + (delay[i % delay.length] ?? 0)),
  )
  return longest > 0 ? Math.min(STATE_SETTLE_MAX_MS, longest + 50) : 0
}

/** Splits a computed list on its commas, not those inside a function (cubic-bezier(…)). */
const listItems = (value = '') => value.split(/,(?![^(]*\))/).map((item) => item.trim())

/**
 * The shorthands STYLE_KEYS reads that the protocol only gives as longhands: `outline` (when
 * there is one) and `transition` (when anything transitions), as "color style width" and
 * "property duration easing delay, …".
 */
function foldShorthands(computed: Map<string, string>) {
  const outline = computed.get('outline-style')
  if (!computed.has('outline') && outline && outline !== 'none')
    computed.set(
      'outline',
      `${computed.get('outline-color') ?? ''} ${outline} ${computed.get('outline-width') ?? ''}`.trim(),
    )
  const durations = listItems(computed.get('transition-duration'))
  if (computed.has('transition') || !durations.some((duration) => Number.parseFloat(duration) > 0))
    return
  const properties = listItems(computed.get('transition-property'))
  const easings = listItems(computed.get('transition-timing-function'))
  const delays = listItems(computed.get('transition-delay'))
  computed.set(
    'transition',
    properties
      .map((property, i) =>
        [
          property,
          durations[i % durations.length],
          easings[i % easings.length],
          delays[i % delays.length],
        ].join(' '),
      )
      .join(', '),
  )
}

export interface InspectorSession {
  /** backendNodeId of the first element matching `selector` */
  querySelector(selector: string): Promise<number>
  /** Hides our highlight while `fn` runs, then shows whatever highlight is current. */
  withoutHighlight<T>(fn: () => Promise<T>): Promise<T>
}

/** Finding, highlighting and reading elements over the Chrome DevTools Protocol. */
export class Inspector extends EventEmitter<InspectorEvents> {
  private readonly dbg
  /** Settles when the last queued exclusive section has finished. */
  private lockTail: Promise<void> = Promise.resolve()
  /** Node shown by `highlight`, so a screenshot can hide it and put it back. */
  private highlighted: number | null = null
  /** Bumped by every highlight change; a queued highlight that's been superseded is dropped. */
  private highlightToken = 0
  private readonly session: InspectorSession = {
    querySelector: (selector) => this.findNode(selector),
    withoutHighlight: (fn) => this.withoutHighlight(fn),
  }

  /**
   * `viewScale` is how large the page is drawn in its view, 1 or less (device frames, see
   * viewport.ts): page coordinates times it are the view's.
   */
  constructor(
    private readonly wc: WebContents,
    private readonly viewScale: () => number,
  ) {
    super()
    this.dbg = wc.debugger
    this.dbg.on('detach', () => this.emit('detach'))
    wc.on('did-navigate', this.onNavigated)
  }

  /** A new document: put the viewport back, whatever a capture under the last one left. */
  private readonly onNavigated = () => this.emit('emulationLost')

  /**
   * Locked so it can't land in the middle of an agent screenshot. `isCurrent` is checked
   * once the lock is held, for callers whose reason to highlight can lapse meanwhile.
   */
  async highlight(backendNodeId: number, isCurrent: () => boolean = () => true) {
    const token = ++this.highlightToken
    await this.exclusive(async () => {
      if (isCurrent()) await this.showHighlight(backendNodeId, token)
    })
  }

  /**
   * Highlights part of the page (page coordinates, CSS pixels) where it is now, for a picked
   * area. It stays put in the viewport until something else is highlighted.
   */
  async highlightArea(area: Rect) {
    const token = ++this.highlightToken
    await this.exclusive(async () => {
      await this.ready()
      if (token !== this.highlightToken) return
      const scroll = await this.scroll()
      const { r, g, b } = accent()
      await this.cmd('Overlay.highlightRect', {
        x: Math.round(area.x - scroll.x),
        y: Math.round(area.y - scroll.y),
        width: Math.round(area.width),
        height: Math.round(area.height),
        color: { r, g, b, a: 0.12 },
        outlineColor: { r, g, b, a: 1 },
      })
      // Not a node, so a screenshot can't put it back; it's only shown while hovered.
      if (token === this.highlightToken) this.highlighted = null
    })
  }

  async clearHighlight() {
    this.highlightToken++
    this.highlighted = null
    await this.hideOverlay()
  }

  /**
   * Runs `fn` alone among everything that uses node ids or reads layout: `DOM.getDocument`
   * invalidates every node id handed out before it, and an agent screenshot and a device
   * frame (viewport.ts) change the emulated viewport, which a concurrent pick or inspection
   * would otherwise read.
   */
  exclusive<T>(fn: (session: InspectorSession) => Promise<T>): Promise<T> {
    const run = this.lockTail.then(() => fn(this.session))
    this.lockTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** backendNodeId of the first element matching `selector`. */
  querySelector(selector: string) {
    return this.exclusive((session) => session.querySelector(selector))
  }

  /**
   * DOM facts come from protocol commands, which page scripts can't intercept,
   * so the picked element's HTML and styles reflect the real node. A null `projectRoot` (a
   * website, not the user's app) looks for no source files.
   */
  async inspect(
    backendNodeId: number,
    projectRoot: string | null,
    devOrigin: string | null,
    options: { screenshot?: boolean } = {},
  ): Promise<ElementContext> {
    await this.ready()
    // Page JavaScript that may wait for hydration; it holds no node ids, so it runs unlocked.
    const pendingReact = this.reactInfo(backendNodeId)
    const { described, outer, rect, viewport, styles, lineage, shot } = await this.exclusive(
      async () => {
        const [described, outer, rect, viewport, { styles, lineage }] = await Promise.all([
          this.cmd<{ node: { localName: string; attributes?: string[] } }>('DOM.describeNode', {
            backendNodeId,
          }),
          this.cmd<{ outerHTML: string }>('DOM.getOuterHTML', { backendNodeId }),
          this.boxRect(backendNodeId),
          this.viewport(),
          this.pushNode(backendNodeId).then(async ({ nodeId, lineage }) => ({
            styles: await this.computedStyles(nodeId),
            lineage,
          })),
        ])
        const shot = options.screenshot === false ? null : await this.capture(rect, viewport)
        return { described, outer, rect, viewport, styles, lineage, shot }
      },
    )
    const react = await pendingReact

    const attributes: Record<string, string> = {}
    const attrs = described.node.attributes ?? []
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      attributes[attrs[i]] = attrs[i + 1].slice(0, 300)
    }
    const html = outer.outerHTML
    const reactSource = projectRoot ? await locateSource(react, projectRoot, devOrigin) : null
    // Pages React didn't render (Astro) can still name their source in dev-mode attributes.
    const source =
      reactSource ?? (projectRoot ? await sourceFromAttributes(lineage, projectRoot) : null)
    const reactStack = react?.componentStack ?? []
    const componentStack =
      reactSource || reactStack.length > 0 || !projectRoot ? reactStack : fileStack(lineage)

    return {
      id: randomUUID(),
      url: this.wc.getURL(),
      viewport,
      tag: described.node.localName,
      selector: react?.selector || described.node.localName,
      text: textFromHtml(html).slice(0, 300),
      attributes,
      outerHTML: html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}…` : html,
      rect,
      styles,
      componentStack,
      source,
      screenshot: shot?.dataUrl ?? null,
      crop: shot?.crop ?? null,
    }
  }

  /**
   * The element's computed styles with `state` forced on it (`:hover`, `:focus`…), as
   * `inspect` reads them. Transitions are let finish first (up to STATE_SETTLE_MAX_MS), so
   * what's read is where the state ends up, not where it starts.
   */
  async stateStyles(backendNodeId: number, state: ForcedState): Promise<Record<string, string>> {
    await this.ready()
    return this.exclusive(async () => {
      const { nodeId } = await this.pushNode(backendNodeId)
      await this.cmd('CSS.enable')
      const classes = state === 'focus' ? ['focus', 'focus-visible', 'focus-within'] : [state]
      await this.cmd('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes })
      try {
        const { computedStyle } = await this.cmd<{
          computedStyle: { name: string; value: string }[]
        }>('CSS.getComputedStyleForNode', { nodeId })
        const value = (name: string) => computedStyle.find((style) => style.name === name)?.value
        const settle = transitionTime(value('transition-duration'), value('transition-delay'))
        if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle))
        return await this.computedStyles(nodeId)
      } finally {
        await this.cmd('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(
          () => undefined,
        )
      }
    })
  }

  /**
   * backendNodeId of the element at `point` (CSS pixels in the viewport), as a click there
   * would reach it; null over nothing. Holds no node ids, so it runs unlocked.
   */
  async nodeAt(point: Point): Promise<number | null> {
    await this.ready()
    try {
      // The protocol hit-tests document coordinates, not the viewport's: past the first
      // screen, a viewport point would land on whatever was scrolled away.
      const { cssLayoutViewport: scroll } = await this.cmd<{
        cssLayoutViewport: { pageX: number; pageY: number }
      }>('Page.getLayoutMetrics')
      const onPage = pageFromViewport(
        viewportPointFrom(point),
        pagePoint(scroll.pageX, scroll.pageY),
      )
      const { backendNodeId } = await this.cmd<{ backendNodeId?: number }>(
        'DOM.getNodeForLocation',
        {
          x: Math.round(onPage.x),
          y: Math.round(onPage.y),
          includeUserAgentShadowDOM: false,
          ignorePointerEventsNone: true,
        },
      )
      return backendNodeId ?? null
    } catch {
      return null
    }
  }

  /** The element's border box in the viewport; null when it has none (or is gone). */
  async box(backendNodeId: number): Promise<Rect | null> {
    const rect = await this.boxRect(backendNodeId).catch(() => null)
    return rect && (rect.width > 0 || rect.height > 0) ? rect : null
  }

  /** How far the page is scrolled: page coordinates less these are the viewport's. */
  async scroll(): Promise<Point> {
    const { cssVisualViewport } = await this.cmd<{
      cssVisualViewport: { pageX: number; pageY: number }
    }>('Page.getLayoutMetrics')
    const scroll = pagePoint(cssVisualViewport.pageX, cssVisualViewport.pageY)
    return { x: scroll.x, y: scroll.y }
  }

  /**
   * What the picking label calls the element: its nearest component, else its tag (with its
   * id). Page data, checked like a component name.
   */
  async label(backendNodeId: number): Promise<string> {
    const { node } = await this.cmd<{ node: { localName: string; attributes?: string[] } }>(
      'DOM.describeNode',
      { backendNodeId },
    )
    const attrs = node.attributes ?? []
    const idAt = attrs.findIndex((name, i) => i % 2 === 0 && name === 'id')
    const id = idAt >= 0 ? attrs[idAt + 1] : ''
    const tag = id && COMPONENT_NAME.test(id) ? `${node.localName}#${id}` : node.localName
    const component = await this.callOn(backendNodeId, HOVER_NAME).catch(() => null)
    return typeof component === 'string' && COMPONENT_NAME.test(component) ? component : tag
  }

  /**
   * A screenshot of `rect` (CSS pixels in the viewport, kept within it) for an area the user
   * dragged out, framed exactly, with where it was.
   */
  async captureArea(rect: Rect) {
    await this.ready()
    return this.exclusive(async () => {
      const viewport = await this.viewport()
      const shot = await this.capture(rect, viewport, 0)
      return { viewport, shot }
    })
  }

  /**
   * backendNodeId of the smallest element around all of `rect` (see CONTAINER), found from
   * the element at its center; null when only the page is.
   */
  async containerOf(rect: Rect): Promise<number | null> {
    const center = await this.nodeAt({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
    if (center === null) return null
    let objectId: string | undefined
    let found: string | undefined
    try {
      const { object } = await this.cmd<{ object: { objectId: string } }>('DOM.resolveNode', {
        backendNodeId: center,
      })
      objectId = object.objectId
      const { result } = await this.cmd<{ result: { objectId?: string; subtype?: string } }>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: CONTAINER,
          arguments: [rect.x, rect.y, rect.width, rect.height].map((value) => ({ value })),
        },
      )
      found = result.subtype === 'node' ? result.objectId : undefined
      if (!found) return null
      const { node } = await this.cmd<{ node: { backendNodeId: number } }>('DOM.describeNode', {
        objectId: found,
      })
      return node.backendNodeId
    } catch {
      return null
    } finally {
      for (const id of [objectId, found]) {
        if (id) void this.cmd('Runtime.releaseObject', { objectId: id }).catch(() => undefined)
      }
    }
  }

  /**
   * Raw CDP access for the agent's preview tools; shares this debugger session. Unlocked:
   * sequences that hold node ids or change emulation belong in `exclusive`.
   */
  async command<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ready()
    return this.cmd<T>(method, params)
  }

  /** `Page.captureScreenshot`, for callers holding the lock; see page-capture.ts. */
  async captureScreenshot(params: Record<string, unknown>): Promise<{ data: string }> {
    await this.ready()
    const sent = this.dbg.sendCommand('Page.captureScreenshot', params) as Promise<{
      data: string
    }>
    return awaitCapture(this.wc, sent, COMMAND_TIMEOUT_MS, () => this.emit('emulationLost'))
  }

  dispose() {
    this.removeAllListeners()
    if (!this.wc.isDestroyed()) this.wc.off('did-navigate', this.onNavigated)
    if (this.dbg.isAttached()) this.dbg.detach()
  }

  /** Unlocked; callers hold the lock across the node ids it uses. */
  private async findNode(selector: string): Promise<number> {
    await this.ready()
    const { root } = await this.cmd<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
    const { nodeId } = await this.cmd<{ nodeId: number }>('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    }).catch((error: unknown) => {
      // Chromium's only error for a selector that doesn't parse; anything else is real.
      if (error instanceof Error && error.message.includes('DOM Error while querying')) {
        throw new Error(`Invalid selector: ${selector}`)
      }
      throw error
    })
    if (!nodeId) throw new Error(`No element matches ${selector}`)
    const { node } = await this.cmd<{ node: { backendNodeId: number } }>('DOM.describeNode', {
      nodeId,
    })
    return node.backendNodeId
  }

  /** No-op once `token` is superseded, so a cleared highlight can't reappear late. */
  private async showHighlight(backendNodeId: number, token = this.highlightToken) {
    await this.ready()
    if (token !== this.highlightToken) return
    await this.cmd('Overlay.highlightNode', {
      backendNodeId,
      highlightConfig: highlightConfig(),
    })
    if (token === this.highlightToken) this.highlighted = backendNodeId
  }

  private async hideOverlay() {
    if (!this.dbg.isAttached()) return
    await this.cmd('Overlay.hideHighlight').catch(() => undefined)
  }

  private async withoutHighlight<T>(fn: () => Promise<T>): Promise<T> {
    if (this.highlighted === null) return fn()
    await this.hideOverlay()
    try {
      return await fn()
    } finally {
      // Restore what's current now; the selection may have gone away meanwhile.
      const node = this.highlighted
      if (node !== null) {
        await this.showHighlight(node).catch(() => {
          // The node is gone, e.g. replaced by hot reload.
          if (this.highlighted === node) this.highlighted = null
        })
      }
    }
  }

  private async boxRect(backendNodeId: number): Promise<Rect> {
    try {
      const { model } = await this.cmd<{ model: { border: number[] } }>('DOM.getBoxModel', {
        backendNodeId,
      })
      const xs = [model.border[0], model.border[2], model.border[4], model.border[6]]
      const ys = [model.border[1], model.border[3], model.border[5], model.border[7]]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
    } catch {
      // Elements without layout (display: contents, hidden) have no box model.
      return { x: 0, y: 0, width: 0, height: 0 }
    }
  }

  private async viewport() {
    const { cssLayoutViewport } = await this.cmd<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number }
    }>('Page.getLayoutMetrics')
    return { width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight }
  }

  /**
   * Unlocked; `inspect` holds the lock around it. Binds `backendNodeId` to a node id. The
   * push reports every node on the path down to it (`DOM.setChildNodes`, sent before the
   * reply), so the element's and its ancestors' source attributes come at no extra cost,
   * from the protocol rather than page JavaScript that could misreport them.
   */
  private async pushNode(backendNodeId: number) {
    const nodes = new Map<number, LineageNode>()
    const collect = (_event: unknown, method: string, params: unknown) => {
      if (method === 'DOM.setChildNodes') addPathNodes(nodes, params)
    }
    this.dbg.on('message', collect)
    try {
      await this.cmd('DOM.getDocument', { depth: 0 })
      const { nodeIds } = await this.cmd<{ nodeIds: number[] }>(
        'DOM.pushNodesByBackendIdsToFrontend',
        { backendNodeIds: [backendNodeId] },
      )
      const nodeId = nodeIds[0]
      const lineage: (SourceTag | null)[] = []
      for (let node = nodes.get(nodeId); node && lineage.length < MAX_LINEAGE; ) {
        lineage.push(node.tag)
        node = node.parentId === undefined ? undefined : nodes.get(node.parentId)
      }
      return { nodeId, lineage }
    } finally {
      this.dbg.off('message', collect)
    }
  }

  /** Unlocked; `inspect` holds the lock around it. */
  private async computedStyles(nodeId: number) {
    await this.cmd('CSS.enable')
    const { computedStyle } = await this.cmd<{
      computedStyle: { name: string; value: string }[]
    }>('CSS.getComputedStyleForNode', { nodeId })
    const computed = new Map(computedStyle.map(({ name, value }) => [name, value]))
    for (const [shorthand, longhands] of Object.entries(BOX_SHORTHANDS)) {
      const values = longhands.map((name) => computed.get(name) ?? '')
      if (values.some((value) => !value)) continue
      computed.set(shorthand, collapseBox(values))
    }
    foldShorthands(computed)
    const borderless = computed.get('border-style') === 'none'
    const styles: Record<string, string> = {}
    for (const name of STYLE_KEYS) {
      const value = computed.get(name) ?? ''
      if (DEFAULT_STYLE_VALUES.has(value) || PROPERTY_DEFAULTS[name]?.includes(value)) continue
      if (name === 'outline' && /\snone\s/.test(` ${value} `)) continue
      if (borderless && name.startsWith('border-') && name !== 'border-radius') continue
      styles[name] = value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
    return styles
  }

  /** Untrusted page data: bounded in time and validated field by field. */
  private async reactInfo(backendNodeId: number): Promise<ReactInfo | null> {
    let objectId: string | undefined
    try {
      const { object } = await this.cmd<{ object: { objectId: string } }>('DOM.resolveNode', {
        backendNodeId,
      })
      objectId = object.objectId
      const call = this.cmd<{ result: { value: unknown }; exceptionDetails?: unknown }>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: REACT_INFO, returnByValue: true, awaitPromise: true },
      )
      const timeout = new Promise<null>((resolve) => setTimeout(resolve, REACT_TIMEOUT_MS, null))
      const response = await Promise.race([call, timeout])
      if (!response || response.exceptionDetails) return null
      return parseReactInfo(response.result.value)
    } catch {
      return null
    } finally {
      if (objectId) void this.cmd('Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
  }

  /** The element and `pad` around it, within the viewport; where, in page coordinates. */
  private async capture(
    rect: Rect,
    viewport: { width: number; height: number },
    pad = CROP_MARGIN,
  ) {
    const x = Math.max(0, Math.floor(rect.x - pad))
    const y = Math.max(0, Math.floor(rect.y - pad))
    const width = Math.min(viewport.width, Math.ceil(rect.x + rect.width + pad)) - x
    const height = Math.min(viewport.height, Math.ceil(rect.y + rect.height + pad)) - y
    if (width < 2 || height < 2) return null
    const { cssVisualViewport: scroll } = await this.cmd<{
      cssVisualViewport: { pageX: number; pageY: number }
    }>('Page.getLayoutMetrics')
    // Hide our overlay so it isn't baked into the crop.
    await this.clearHighlight()
    // The view shows the page at its frame's scale. At least a pixel: an empty rect would
    // capture the whole view.
    const scale = this.viewScale()
    const view = viewRectFromViewport(viewportRect(x, y, width, height), scale)
    const image = await this.wc.capturePage({
      x: Math.round(view.x),
      y: Math.round(view.y),
      width: Math.max(1, Math.round(view.width)),
      height: Math.max(1, Math.round(view.height)),
    })
    if (image.isEmpty()) return null
    const size = image.getSize()
    const scaled = size.width > 1200 ? image.resize({ width: 1200, quality: 'good' }) : image
    const origin = pagePoint(scroll.pageX, scroll.pageY)
    const onPage = (box: Rect) => {
      const page = pageRectFromViewport(viewportRect(box.x, box.y, box.width, box.height), origin)
      return { x: page.x, y: page.y, width: page.width, height: page.height }
    }
    return {
      dataUrl: scaled.toDataURL(),
      crop: { area: onPage({ x, y, width, height }), element: onPage(rect) },
    }
  }

  /** Calls page JavaScript on the element, by value; bounded like REACT_INFO, untrusted. */
  private async callOn(backendNodeId: number, functionDeclaration: string): Promise<unknown> {
    const { object } = await this.cmd<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId,
    })
    try {
      const { result, exceptionDetails } = await this.cmd<{
        result: { value?: unknown }
        exceptionDetails?: unknown
      }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration,
        returnByValue: true,
      })
      return exceptionDetails ? null : result.value
    } finally {
      void this.cmd('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined)
    }
  }

  private async ready() {
    if (!this.dbg.isAttached()) this.dbg.attach('1.3')
    // Idempotent; re-run because renderer swaps on cross-origin navigation can drop domain state.
    await this.cmd('DOM.enable')
    await this.cmd('Overlay.enable')
  }

  /** Bounded: a page stuck in a script would otherwise hold `exclusive` forever. */
  private cmd<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} timed out`)), COMMAND_TIMEOUT_MS)
    })
    return Promise.race([this.dbg.sendCommand(method, params) as Promise<T>, timeout]).finally(() =>
      clearTimeout(timer),
    )
  }
}

/** Writes four box values the way a person would: `8px`, `8px 16px`, `8px 16px 4px`. */
function collapseBox([top, right, bottom, left]: string[]) {
  if (right === left) {
    if (top === bottom) return top === right ? top : `${top} ${right}`
    return `${top} ${right} ${bottom}`
  }
  return `${top} ${right} ${bottom} ${left}`
}

const COMPONENT_NAME = /^[A-Za-z_$][\w$.]{0,79}$/

function oneLine(value: unknown, max: number) {
  return typeof value === 'string' ? value.replace(/[\s\p{Cc}]+/gu, ' ').slice(0, max) : ''
}

function parseReactInfo(value: unknown): ReactInfo | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const componentStack = Array.isArray(raw.componentStack)
    ? raw.componentStack
        .filter((name): name is string => typeof name === 'string' && COMPONENT_NAME.test(name))
        .slice(0, 6)
    : []
  let debugSource: ReactInfo['debugSource'] = null
  const source = raw.debugSource as Record<string, unknown> | null
  if (
    source &&
    typeof source.fileName === 'string' &&
    source.fileName.length < 1000 &&
    Number.isInteger(source.lineNumber) &&
    (source.lineNumber as number) > 0
  ) {
    debugSource = {
      fileName: source.fileName,
      lineNumber: source.lineNumber as number,
      columnNumber: Number.isInteger(source.columnNumber)
        ? (source.columnNumber as number)
        : undefined,
    }
  }
  return {
    selector: oneLine(raw.selector, 300),
    componentStack,
    debugStack: typeof raw.debugStack === 'string' ? raw.debugStack.slice(0, 20_000) : null,
    debugSource,
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
}

function textFromHtml(html: string) {
  return html
    .replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// React's replayed server-component frames wrap the real URL: rsc://React/Server/<url>?<n>
const SERVER_FRAME = /(?:rsc|about):\/\/React\/[^/\s]+\/(.+?)\?\d+(?=:\d+:\d+)/g

async function locateSource(
  react: ReactInfo | null,
  projectRoot: string,
  devOrigin: string | null,
): Promise<SourceLocation | null> {
  if (!react) return null
  const { debugSource, debugStack } = react
  if (debugSource) {
    const file = normalizeSourcePath(debugSource.fileName, projectRoot)
    if (file && (await isFile(join(projectRoot, file)))) {
      return {
        file,
        line: debugSource.lineNumber,
        column: debugSource.columnNumber,
        approximate: false,
      }
    }
  }
  if (!debugStack) return null
  const unwrapped = debugStack.replace(SERVER_FRAME, (_match, inner: string) => {
    try {
      return decodeURI(inner)
    } catch {
      return inner
    }
  })
  return resolveStack(unwrapped, projectRoot, devOrigin ?? undefined)
}

/** Records the nodes of a `DOM.setChildNodes` event: each one's parent and source tag. */
function addPathNodes(into: Map<number, LineageNode>, params: unknown) {
  const event = params as {
    parentId?: number
    nodes?: { nodeId: number; parentId?: number; attributes?: string[] }[]
  }
  for (const node of event.nodes ?? []) {
    into.set(node.nodeId, {
      parentId: node.parentId ?? event.parentId,
      tag: sourceTag(node.attributes ?? []),
    })
  }
}

/** The first SOURCE_ATTRIBUTES pair an element carries; attributes come as name, value, … */
function sourceTag(attributes: string[]): SourceTag | null {
  const value = (name: string) => {
    for (let i = 0; i + 1 < attributes.length; i += 2) {
      if (attributes[i] === name) return attributes[i + 1]
    }
    return null
  }
  for (const names of SOURCE_ATTRIBUTES) {
    const file = value(names.file)
    if (file && file.length < 1000) return { file, loc: value(names.loc) }
  }
  return null
}

/**
 * Where the nearest element with source attributes (the picked one or an ancestor) was
 * written. A library's component (Astro's <Image>) is passed over for the app element
 * around it, so that location is approximate.
 */
async function sourceFromAttributes(
  lineage: (SourceTag | null)[],
  projectRoot: string,
): Promise<SourceLocation | null> {
  let passedLibrary = false
  for (const tag of lineage.slice(0, SOURCE_ANCESTORS + 1)) {
    if (!tag) continue
    if (tag.file.replace(/\\/g, '/').split('/').includes('node_modules')) {
      passedLibrary = true
      continue
    }
    // Outside this root: a monorepo app's caller tries again from the repo root.
    const file = projectRelativePath(tag.file, projectRoot)
    if (!file || !(await isFile(join(projectRoot, file)))) return null
    const loc = /^(\d{1,7})(?::(\d{1,7}))?$/.exec(tag.loc ?? '')
    const line = Number(loc?.[1])
    if (!loc || line < 1) return { file, line: 1, approximate: true }
    const column = loc[2] ? Number(loc[2]) : undefined
    return { file, line, column, approximate: passedLibrary }
  }
  return null
}

const FILE_NAME = /^[A-Za-z_$][\w$.-]{0,79}$/

/** Names of the files that wrote the element and its ancestors, innermost first: `Hero`, `Layout`. */
function fileStack(lineage: (SourceTag | null)[]): string[] {
  const names: string[] = []
  for (const tag of lineage) {
    if (!tag) continue
    const base = tag.file.slice(Math.max(tag.file.lastIndexOf('/'), tag.file.lastIndexOf('\\')) + 1)
    const dot = base.lastIndexOf('.')
    const name = dot > 0 ? base.slice(0, dot) : base
    if (FILE_NAME.test(name) && !names.includes(name)) names.push(name)
    if (names.length === MAX_FILE_STACK) break
  }
  return names
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
