import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeTheme, type WebContents } from 'electron'
import { ACCENT, FILL } from '../shared/theme'
import type { ElementContext, Rect, SourceLocation } from '../shared/types'
import { normalizeSourcePath, projectRelativePath, resolveStack } from './source-resolver'

const COMMAND_TIMEOUT_MS = 15_000
/**
 * Room around a picked element in its crop. The turn's after image frames the element
 * with the same margin, so the two line up.
 */
export const CROP_MARGIN = 8
/**
 * The element highlight in Gui's accent for the current appearance: the content tinted, the
 * padding lighter, the margin a neutral fill, an accent outline.
 */
function highlightConfig() {
  const dark = nativeTheme.shouldUseDarkColors
  const hex = dark ? ACCENT.dark : ACCENT.light
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  return {
    showInfo: true,
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
  pick: [backendNodeId: number]
  cancel: []
  /** The debugger session closed; what it set up, such as emulation, went with it. */
  detach: []
}

/**
 * What code running inside `Inspector.exclusive` may use. These skip the lock; the
 * public equivalents would wait for it and deadlock.
 */
export interface InspectorSession {
  /** backendNodeId of the first element matching `selector` */
  querySelector(selector: string): Promise<number>
  /** Hides our highlight while `fn` runs, then shows whatever highlight is current. */
  withoutHighlight<T>(fn: () => Promise<T>): Promise<T>
}

/** Element picking and extraction over the Chrome DevTools Protocol. */
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
    this.dbg.on('message', (_event, method, params) => {
      if (method === 'Overlay.inspectNodeRequested') {
        void this.setInspecting(false)
        this.emit('pick', (params as { backendNodeId: number }).backendNodeId)
      } else if (method === 'Overlay.inspectModeCanceled') {
        this.emit('cancel')
      }
    })
  }

  async setInspecting(on: boolean) {
    await this.ready()
    await this.cmd('Overlay.setInspectMode', {
      mode: on ? 'searchForNode' : 'none',
      highlightConfig: highlightConfig(),
    })
  }

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
   * so the picked element's HTML and styles reflect the real node.
   */
  async inspect(
    backendNodeId: number,
    projectRoot: string,
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
    const reactSource = await locateSource(react, projectRoot, devOrigin)
    // Pages React didn't render (Astro) can still name their source in dev-mode attributes.
    const source = reactSource ?? (await sourceFromAttributes(lineage, projectRoot))
    const reactStack = react?.componentStack ?? []
    const componentStack = reactSource || reactStack.length > 0 ? reactStack : fileStack(lineage)

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
   * Raw CDP access for the agent's preview tools; shares this debugger session. Unlocked:
   * sequences that hold node ids or change emulation belong in `exclusive`.
   */
  async command<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ready()
    return this.cmd<T>(method, params)
  }

  dispose() {
    this.removeAllListeners()
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
    await this.cmd('Overlay.highlightNode', { backendNodeId, highlightConfig: highlightConfig() })
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

  /** The element and `CROP_MARGIN` around it, within the viewport; where, in page coordinates. */
  private async capture(rect: Rect, viewport: { width: number; height: number }) {
    const pad = CROP_MARGIN
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
    const image = await this.wc.capturePage({
      x: Math.round(x * scale),
      y: Math.round(y * scale),
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    })
    if (image.isEmpty()) return null
    const size = image.getSize()
    const scaled = size.width > 1200 ? image.resize({ width: 1200, quality: 'good' }) : image
    const onPage = (box: Rect) => ({ ...box, x: box.x + scroll.pageX, y: box.y + scroll.pageY })
    return {
      dataUrl: scaled.toDataURL(),
      crop: { area: onPage({ x, y, width, height }), element: onPage(rect) },
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
