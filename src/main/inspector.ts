import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type { ElementContext, Rect, SourceLocation } from '../shared/types'
import { normalizeSourcePath, resolveStack } from './source-resolver'

const HIGHLIGHT = {
  showInfo: true,
  showStyles: false,
  showAccessibilityInfo: false,
  contentColor: { r: 59, g: 130, b: 246, a: 0.16 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.3 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.3 },
  borderColor: { r: 59, g: 130, b: 246, a: 0.95 },
}

/**
 * Runs in the page's main world with `this` bound to the picked element. Plain JS
 * string so bundling can't inject helpers that don't exist in the page.
 */
const EXTRACT = `async function () {
  const el = this
  const fiberKey = () => Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  // Server-rendered React pages are clickable before hydration attaches fibers.
  const ssr = self.__next_f || self.__NEXT_DATA__ || self.__reactRouterContext || self.__remixContext
  for (let i = 0; ssr && !fiberKey() && i < 30; i++) await new Promise((r) => setTimeout(r, 100))
  const cs = getComputedStyle(el)
  const keys = ['display','position','width','height','margin','padding','gap','flex-direction',
    'align-items','justify-content','grid-template-columns','color','background-color',
    'background-image','font-family','font-size','font-weight','line-height','letter-spacing',
    'text-align','text-transform','border','border-radius','box-shadow','opacity','overflow','z-index']
  const skip = new Set(['', 'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', 'visible'])
  const styles = {}
  for (const key of keys) {
    const value = cs.getPropertyValue(key)
    if (!skip.has(value)) styles[key] = value.length > 200 ? value.slice(0, 200) + '…' : value
  }
  const attributes = {}
  for (const attr of el.attributes) attributes[attr.name] = attr.value.slice(0, 300)

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
    for (let f = fiber; f && !debugStack && !debugSource; f = f._debugOwner || null) {
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

  const rect = el.getBoundingClientRect()
  const html = el.outerHTML
  return {
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    tag: el.localName,
    selector: path.join(' > '),
    text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300),
    attributes,
    outerHTML: html.length > 4000 ? html.slice(0, 4000) + '…' : html,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    styles,
    componentStack,
    debugStack,
    debugSource,
  }
}`

interface RawElement extends Omit<ElementContext, 'id' | 'source' | 'screenshot'> {
  debugStack: string | null
  debugSource: { fileName: string; lineNumber: number; columnNumber?: number } | null
}

interface InspectorEvents {
  pick: [backendNodeId: number]
  cancel: []
}

/** Element picking and extraction over the Chrome DevTools Protocol. */
export class Inspector extends EventEmitter<InspectorEvents> {
  private readonly dbg

  constructor(private readonly wc: WebContents) {
    super()
    this.dbg = wc.debugger
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
      highlightConfig: HIGHLIGHT,
    })
  }

  async highlight(backendNodeId: number) {
    await this.ready()
    await this.cmd('Overlay.highlightNode', { backendNodeId, highlightConfig: HIGHLIGHT })
  }

  async clearHighlight() {
    if (!this.dbg.isAttached()) return
    await this.cmd('Overlay.hideHighlight').catch(() => undefined)
  }

  async inspect(backendNodeId: number, projectRoot: string): Promise<ElementContext> {
    await this.ready()
    const { object } = await this.cmd<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId,
    })
    let raw: RawElement
    try {
      const { result, exceptionDetails } = await this.cmd<{
        result: { value: RawElement }
        exceptionDetails?: { text: string }
      }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: EXTRACT,
        returnByValue: true,
        awaitPromise: true,
      })
      if (exceptionDetails) throw new Error(`Element extraction failed: ${exceptionDetails.text}`)
      raw = result.value
    } finally {
      void this.cmd('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined)
    }

    const { debugStack, debugSource, ...element } = raw
    const [source, screenshot] = await Promise.all([
      locateSource(debugStack, debugSource, projectRoot),
      this.capture(element.rect, element.viewport),
    ])
    return { ...element, id: randomUUID(), source, screenshot }
  }

  dispose() {
    this.removeAllListeners()
    if (this.dbg.isAttached()) this.dbg.detach()
  }

  private async capture(rect: Rect, viewport: { width: number; height: number }) {
    const pad = 8
    const x = Math.max(0, Math.floor(rect.x - pad))
    const y = Math.max(0, Math.floor(rect.y - pad))
    const width = Math.min(viewport.width, Math.ceil(rect.x + rect.width + pad)) - x
    const height = Math.min(viewport.height, Math.ceil(rect.y + rect.height + pad)) - y
    if (width < 2 || height < 2) return null
    // Hide our overlay so it isn't baked into the crop.
    await this.clearHighlight()
    const image = await this.wc.capturePage({ x, y, width, height })
    if (image.isEmpty()) return null
    const size = image.getSize()
    const scaled = size.width > 1200 ? image.resize({ width: 1200, quality: 'good' }) : image
    return scaled.toDataURL()
  }

  private async ready() {
    if (!this.dbg.isAttached()) this.dbg.attach('1.3')
    // Idempotent; re-run because renderer swaps on cross-origin navigation can drop domain state.
    await this.cmd('DOM.enable')
    await this.cmd('Overlay.enable')
  }

  private cmd<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.dbg.sendCommand(method, params) as Promise<T>
  }
}

// React's replayed server-component frames wrap the real URL: rsc://React/Server/<url>?<n>
const SERVER_FRAME = /(?:rsc|about):\/\/React\/[^/\s]+\/(.+?)\?\d+(?=:\d+:\d+)/g

async function locateSource(
  debugStack: string | null,
  debugSource: RawElement['debugSource'],
  projectRoot: string,
): Promise<SourceLocation | null> {
  if (debugSource) {
    const file = normalizeSourcePath(debugSource.fileName, projectRoot)
    if (file) {
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
  return resolveStack(unwrapped, projectRoot)
}
