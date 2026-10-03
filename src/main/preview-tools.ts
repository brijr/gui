import type { WebContents } from 'electron'
import type { ElementContext } from '../shared/types'
import type { Inspector } from './inspector'
import { isLoopback } from './loopback'
import type { Problems } from './problems'

const MAX_IMAGE_WIDTH = 1600
const MAX_FULL_PAGE_HEIGHT = 8000
const COMMAND_TIMEOUT_MS = 15_000
const ESC = '\u001b'
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^\u0007]*(?:\u0007|${ESC}\\\\)`, 'g')

export interface Screenshot {
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  viewportWidth: number
}

export interface PreviewToolsDeps {
  wc: WebContents
  inspector: Inspector
  problems: Problems
  projectRoot: () => string | null
  devOrigin: () => string | null
  /** Current preview URL, or null when nothing is loaded */
  currentUrl: () => string | null
  navigate: (url: string) => Promise<void>
  logs: () => string
}

interface LayoutMetrics {
  cssLayoutViewport: { clientWidth: number; clientHeight: number }
  cssVisualViewport: { pageX: number; pageY: number }
  cssContentSize: { width: number; height: number }
}

function withTimeout<T>(promise: Promise<T>, label: string) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), COMMAND_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** What the agent can do with the live preview: look at it, measure it, read its errors. */
export class PreviewTools {
  constructor(private readonly deps: PreviewToolsDeps) {}

  /**
   * Captures the preview. `width` temporarily emulates that viewport width (the user
   * sees it briefly) so the agent can check responsive layouts.
   */
  async screenshot(options: {
    selector?: string
    width?: number
    fullPage?: boolean
  }): Promise<Screenshot> {
    this.assertLoaded()
    const restore = options.width ? await this.emulateWidth(options.width) : null
    try {
      const metrics = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
      const viewportWidth = metrics.cssLayoutViewport.clientWidth
      let clip: { x: number; y: number; width: number; height: number }
      if (options.selector) {
        const backendNodeId = await this.find(options.selector)
        await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
        const fresh = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
        const { model } = await this.cmd<{ model: { border: number[] } }>('DOM.getBoxModel', {
          backendNodeId,
        })
        const xs = [model.border[0], model.border[2], model.border[4], model.border[6]]
        const ys = [model.border[1], model.border[3], model.border[5], model.border[7]]
        const pad = 16
        clip = {
          x: Math.max(0, Math.min(...xs) - pad + fresh.cssVisualViewport.pageX),
          y: Math.max(0, Math.min(...ys) - pad + fresh.cssVisualViewport.pageY),
          width: Math.max(...xs) - Math.min(...xs) + pad * 2,
          height: Math.max(...ys) - Math.min(...ys) + pad * 2,
        }
      } else if (options.fullPage) {
        clip = {
          x: 0,
          y: 0,
          width: metrics.cssContentSize.width,
          height: Math.min(metrics.cssContentSize.height, MAX_FULL_PAGE_HEIGHT),
        }
      } else {
        clip = {
          x: metrics.cssVisualViewport.pageX,
          y: metrics.cssVisualViewport.pageY,
          width: viewportWidth,
          height: metrics.cssLayoutViewport.clientHeight,
        }
      }
      const dpr = await this.devicePixelRatio()
      const scale = Math.min(1, MAX_IMAGE_WIDTH / (clip.width * dpr))
      const jpeg = options.fullPage === true
      const { data } = await this.cmd<{ data: string }>('Page.captureScreenshot', {
        format: jpeg ? 'jpeg' : 'png',
        quality: jpeg ? 80 : undefined,
        clip: { ...clip, scale },
        captureBeyondViewport: options.fullPage === true,
        fromSurface: true,
      })
      return {
        data,
        mimeType: jpeg ? 'image/jpeg' : 'image/png',
        width: Math.round(clip.width * scale * dpr),
        height: Math.round(clip.height * scale * dpr),
        viewportWidth,
      }
    } finally {
      await restore?.()
    }
  }

  /** Computed styles, box, and source location for the first element matching `selector`. */
  async inspect(selector: string): Promise<Omit<ElementContext, 'screenshot'>> {
    this.assertLoaded()
    const backendNodeId = await this.find(selector)
    const root = this.deps.projectRoot()
    if (!root) throw new Error('No project is open')
    const { screenshot: _screenshot, ...element } = await this.deps.inspector.inspect(
      backendNodeId,
      root,
      this.deps.devOrigin(),
      { screenshot: false },
    )
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
    await this.deps.navigate(url.toString())
    await sleep(300)
    return this.deps.currentUrl()
  }

  async reload() {
    this.assertLoaded()
    this.deps.wc.reload()
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      this.deps.wc.once('did-stop-loading', done)
      setTimeout(done, 10_000)
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

  private async find(selector: string) {
    const { root } = await this.cmd<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
    const { nodeId } = await this.cmd<{ nodeId: number }>('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    }).catch(() => ({ nodeId: 0 }))
    if (!nodeId) throw new Error(`No element matches ${selector}`)
    const { node } = await this.cmd<{ node: { backendNodeId: number } }>('DOM.describeNode', {
      nodeId,
    })
    return node.backendNodeId
  }

  private async emulateWidth(width: number) {
    const clamped = Math.round(Math.min(Math.max(width, 240), 3840))
    const metrics = await this.cmd<LayoutMetrics>('Page.getLayoutMetrics')
    await this.cmd('Emulation.setDeviceMetricsOverride', {
      width: clamped,
      height: metrics.cssLayoutViewport.clientHeight,
      deviceScaleFactor: 0,
      mobile: clamped < 768,
    })
    // Let media queries, layout, and lazy content settle.
    await sleep(400)
    return async () => {
      await this.cmd('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
    }
  }

  private async devicePixelRatio() {
    const { result } = await this.cmd<{ result: { value: unknown } }>('Runtime.evaluate', {
      expression: 'devicePixelRatio',
      returnByValue: true,
    })
    const value = Number(result.value)
    return Number.isFinite(value) && value > 0 && value <= 4 ? value : 1
  }

  private cmd<T = unknown>(method: string, params?: Record<string, unknown>) {
    return withTimeout(this.deps.inspector.command<T>(method, params), method)
  }
}
