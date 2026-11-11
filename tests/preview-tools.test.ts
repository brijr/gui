import { describe, expect, test } from 'bun:test'
import type { EncodableImage } from '../src/main/agent-image'

// The agent's page tools against a stand-in page: what they refuse and what they return.
// docs/architecture.md ("Preview tools for the agent") is the specification.

/** A stand-in image whose encodings shrink with it: PNG 4 bytes a pixel, JPEG by quality. */
class FakeImage implements EncodableImage {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getSize() {
    return { width: this.width, height: this.height }
  }
  toPNG() {
    return Buffer.alloc(this.width * this.height * 4)
  }
  toJPEG(quality: number) {
    return Buffer.alloc(Math.round((this.width * this.height * quality) / 100))
  }
  resize({ width, height }: { width: number; height: number }) {
    return new FakeImage(width, height) as this
  }
  isEmpty() {
    return false
  }
}

const { encodeWithin, MAX_AGENT_IMAGE_BYTES } = await import('../src/main/agent-image')
const { PreviewTools, withinBytes } = await import('../src/main/preview-tools')
const { logTail, LOG_LINE_MAX, LOG_TAIL_MAX } = await import('../src/main/startup')
type Deps = ConstructorParameters<typeof PreviewTools>[0]

const TARGET = { x: 10, y: 20, disabled: false, editable: false, submits: false }

/** A page at `url`, scrolled `scroll` px down, answering the protocol commands the tools send. */
function page(options: {
  url?: string
  origins?: string[]
  live?: () => boolean
  scroll?: number
  onGlide?: () => void
  loading?: boolean
}) {
  const sent: { method: string; params?: Record<string, unknown> }[] = []
  const answers: Record<string, (params?: Record<string, unknown>) => unknown> = {
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.querySelectorAll': () => ({ nodeIds: [2] }),
    'DOM.describeNode': () => ({ node: { backendNodeId: 7, localName: 'button' } }),
    'DOM.scrollIntoViewIfNeeded': () => ({}),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main' } } }),
    'Page.createIsolatedWorld': () => ({ executionContextId: 3 }),
    'DOM.resolveNode': () => ({ object: { objectId: 'node' } }),
    'Runtime.callFunctionOn': () => ({ result: { value: TARGET } }),
    'Runtime.releaseObject': () => ({}),
    'Input.dispatchMouseEvent': () => ({}),
    'DOM.getBoxModel': () => ({ model: { border: [40, 100, 140, 100, 140, 150, 40, 150] } }),
    'Page.getLayoutMetrics': () => ({
      cssVisualViewport: {
        pageX: 0,
        pageY: options.scroll ?? 0,
        clientWidth: 800,
        clientHeight: 600,
      },
    }),
  }
  const inspector = {
    exclusive: <T>(fn: (session: unknown) => Promise<T>) =>
      fn({ withoutHighlight: <R>(run: () => Promise<R>) => run() }),
    command: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params })
      return answers[method]?.(params) ?? {}
    },
    querySelector: async () => 7,
  }
  let loading = options.loading ?? false
  const wc = {
    isDestroyed: () => false,
    getURL: () => options.url ?? 'http://localhost:5173/',
    getTitle: () => 'App',
    isLoading: () => loading,
    reload: () => undefined,
    // A redirect: one load stops, and the next is already under way.
    on: (_event: string, listener: () => void) => setTimeout(listener, 10),
    off: () => undefined,
  }
  const deps = {
    wc,
    inspector,
    live: options.live ?? (() => true),
    origins: () => options.origins ?? ['http://localhost:5173'],
    elsewhere: "The preview is not showing the user's app.",
    inspectNode: async () => ({
      id: 'random',
      url: 'http://localhost:5173/',
      viewport: { width: 800, height: 600 },
      tag: 'button',
      selector: 'button',
      text: 'Buy',
      attributes: {},
      outerHTML: '<button>Buy</button>',
      rect: { x: 40, y: 100, width: 100, height: 50 },
      styles: {},
      componentStack: [],
      source: null,
      screenshot: null,
      crop: null,
    }),
    guide: () => true,
    guideInput: async () => options.onGlide?.(),
    website: { shown: () => null, takeClosedNote: () => null, close: () => undefined },
  } as unknown as Deps
  return {
    tools: new PreviewTools(deps),
    clicked: () =>
      sent.some(
        (c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed',
      ),
    stillLoading: (value: boolean) => {
      loading = value
    },
  }
}

describe('a project switch while a tool runs', () => {
  test("a click whose pointer was still gliding when the project closed doesn't land", async () => {
    let live = true
    const { tools, clicked } = page({ live: () => live, onGlide: () => (live = false) })
    const app = tools.shown()
    await expect(app.input((interactions) => interactions.click('#buy'))).rejects.toThrow(
      /project was closed/,
    )
    expect(clicked()).toBe(false)
  })

  test('with the project still open, the same click lands', async () => {
    const { tools, clicked } = page({})
    await tools.shown().input((interactions) => interactions.click('#buy'))
    expect(clicked()).toBe(true)
  })

  test('a call that starts after the project closed does nothing', () => {
    const { tools } = page({ live: () => false })
    expect(() => tools.shown()).toThrow(/project was closed/)
  })
})

describe("the app's tools act only on the app's own origin", () => {
  test('another server on this machine, which the app linked to, is refused', async () => {
    const { tools, clicked } = page({ url: 'http://localhost:8888/tree' })
    await expect(tools.shown().interactions.snapshot()).rejects.toThrow(
      /not showing the user's app/,
    )
    await expect(tools.shown().input((interactions) => interactions.click('#buy'))).rejects.toThrow(
      /not showing the user's app/,
    )
    expect(clicked()).toBe(false)
  })

  test('another address the dev server printed itself is the app too', async () => {
    const { tools, clicked } = page({
      url: 'http://localhost:3001/',
      origins: ['http://localhost:5173', 'http://localhost:3001'],
    })
    await tools.shown().input((interactions) => interactions.click('#buy'))
    expect(clicked()).toBe(true)
  })
})

test("inspect gives the element's box in page pixels, labelled, and nothing it can't use", async () => {
  const { tools } = page({ scroll: 500 })
  const element = await tools.inspect('button')
  // 100px down the viewport, 500px down the page.
  const { x, y, width, height } = element.pageBox
  expect({ x, y, width, height }).toEqual({ x: 40, y: 600, width: 100, height: 50 })
  expect(element).not.toHaveProperty('rect')
  expect(element).not.toHaveProperty('id')
  expect(element).not.toHaveProperty('crop')
  // A selector that only repeats the tag says nothing.
  expect(element).not.toHaveProperty('selector')
})

test("reload says when the page hasn't finished loading", async () => {
  const { tools, stillLoading } = page({})
  stillLoading(true)
  const reloaded = await tools.reload()
  expect(reloaded).toEqual({ url: 'http://localhost:5173/', loading: true })
})

describe('screenshots fit what the agent takes in', () => {
  const shot = (bytes: number) => ({
    data: Buffer.alloc(bytes).toString('base64'),
    mimeType: 'image/png' as 'image/png' | 'image/jpeg',
    width: 1600,
    height: 1960,
    viewportWidth: 800,
    cutAt: null,
    fullHeight: 1960,
  })

  test('one under the cap stays as it was', async () => {
    const small = shot(1000)
    expect(await withinBytes(small)).toBe(small)
  })

  test('one over it comes back as a JPEG within it', async () => {
    const capped = await withinBytes(
      shot(MAX_AGENT_IMAGE_BYTES + 1),
      () => new FakeImage(1600, 1960),
    )
    expect(capped.mimeType).toBe('image/jpeg')
    expect(Buffer.from(capped.data, 'base64').length).toBeLessThanOrEqual(MAX_AGENT_IMAGE_BYTES)
  })

  test('an image too big even as a JPEG is made smaller until it fits', () => {
    const encoded = encodeWithin(new FakeImage(4000, 4000), { png: false })
    expect(encoded.data.length).toBeLessThanOrEqual(MAX_AGENT_IMAGE_BYTES)
    expect(encoded.width).toBeLessThan(4000)
    expect(encoded.mimeType).toBe('image/jpeg')
  })

  test('a PNG that fits stays a PNG', () => {
    const encoded = encodeWithin(new FakeImage(100, 100))
    expect(encoded.mimeType).toBe('image/png')
  })
})

describe('dev server output is cut to fit', () => {
  test('long lines are cut with a marker', () => {
    const tail = logTail(`short\n${'x'.repeat(LOG_LINE_MAX + 100)}`, 10)
    expect(tail).toContain('short')
    expect(tail).toContain('…[100 more characters]')
    expect(tail.split('\n')[1].length).toBeLessThan(LOG_LINE_MAX + 40)
  })

  test('past the character cap, the oldest lines go first and it says so', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i} ${'y'.repeat(200)}`)
    const tail = logTail(lines.join('\n'), 400)
    expect(tail.length).toBeLessThanOrEqual(LOG_TAIL_MAX + 40)
    expect(tail).toMatch(/^…\[\d+ earlier lines left out\]/)
    expect(tail.endsWith(lines[399])).toBe(true)
  })
})
