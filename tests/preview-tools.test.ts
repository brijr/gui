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
const { changedStyles, PreviewTools, withinBytes } = await import('../src/main/preview-tools')
const { describeClip } = await import('../src/main/mcp-preview-tools')
const { logTail, LOG_LINE_MAX, LOG_TAIL_MAX } = await import('../src/main/startup')
type Deps = ConstructorParameters<typeof PreviewTools>[0]

const TARGET = { x: 10, y: 20, disabled: false, editable: true, submits: false }

/** A page at `url`, scrolled `scroll` px down, answering the protocol commands the tools send. */
function page(options: {
  url?: string
  origins?: string[]
  live?: () => boolean
  scroll?: number
  onGlide?: () => void
  /** The user watches the page: typing and the wheel take their time */
  paced?: boolean
  /** Each protocol command, as it's sent */
  onCommand?: (method: string) => void
  loading?: boolean
  /** What the page says to preview_wait's check, call by call */
  present?: () => unknown
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
    'Runtime.evaluate': () => ({ result: { value: options.present?.() } }),
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
      options.onCommand?.(method)
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
    pointer: {
      paced: () => options.paced ?? false,
      move: async () => options.onGlide?.(),
      key: () => undefined,
    },
    website: { shown: () => null, takeClosedNote: () => null, close: () => undefined },
  } as unknown as Deps
  return {
    tools: new PreviewTools(deps),
    clicked: () =>
      sent.some(
        (c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed',
      ),
    /** What was typed, piece by piece */
    typed: () =>
      sent.filter((c) => c.method === 'Input.insertText').map((c) => String(c.params?.text)),
    /** The wheel's deltas, event by event */
    wheeled: () =>
      sent
        .filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseWheel')
        .map((c) => Number(c.params?.deltaY)),
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

  test('typing the user watches stops at the piece it was on when the project closed', async () => {
    let live = true
    const { tools, typed } = page({
      paced: true,
      live: () => live,
      onCommand: (method) => {
        if (method === 'Input.insertText') live = false
      },
    })
    await expect(
      tools.shown().input((interactions) => interactions.type('#name', 'Ada Lovelace')),
    ).rejects.toThrow(/project was closed/)
    expect(typed()).toEqual(['A'])
  })

  test('a call that starts after the project closed does nothing', () => {
    const { tools } = page({ live: () => false })
    expect(() => tools.shown()).toThrow(/project was closed/)
  })
})

describe('input the user watches goes at a pace they can follow', () => {
  test('typing goes in a few characters at a time, adding up to the text', async () => {
    const { tools, typed } = page({ paced: true })
    await tools.shown().input((interactions) => interactions.type('#name', 'Ada 👩🏽‍💻'))
    expect(typed().length).toBeGreaterThan(1)
    expect(typed().join('')).toBe('Ada 👩🏽‍💻')
    // The emoji goes in whole.
    expect(typed()).toContain('👩🏽‍💻')
  })

  test('unwatched, it types all at once', async () => {
    const { tools, typed } = page({})
    await tools.shown().input((interactions) => interactions.type('#name', 'Ada Lovelace'))
    expect(typed()).toEqual(['Ada Lovelace'])
  })

  test('the wheel scrolls in steps that slow down and add up to the whole', async () => {
    const { tools, wheeled } = page({ paced: true })
    await tools.shown().input((interactions) => interactions.scroll(600))
    const deltas = wheeled()
    expect(deltas.length).toBeGreaterThan(5)
    expect(deltas.reduce((sum, delta) => sum + delta, 0)).toBeCloseTo(600, 6)
    expect(deltas[0]).toBeGreaterThan(deltas[deltas.length - 1])
  })

  test('preview_motion scrolls at once, so its film starts as the scroll lands', async () => {
    const { tools, wheeled } = page({ paced: true })
    await tools.shown().input((interactions) => interactions.scroll(600), { atOnce: true })
    expect(wheeled()).toEqual([600])
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

describe('preview_wait', () => {
  test('returns once the page shows what it waits for', async () => {
    let checks = 0
    const { tools } = page({ present: () => ++checks >= 3 })
    expect(await tools.shown().wait({ selector: '#toast' })).toMatch(
      /^`#toast` showed after \d+ms\.$/,
    )
    expect(checks).toBe(3)
  })

  test('says so when it never shows, after at most the time asked', async () => {
    const { tools } = page({ present: () => false })
    const started = Date.now()
    expect(await tools.shown().wait({ text: 'Saved', ms: 300 })).toBe(
      '"Saved" didn\'t show after 300ms.',
    )
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('waits for something to go away', async () => {
    let checks = 0
    const { tools } = page({ present: () => ++checks < 2 })
    expect(await tools.shown().wait({ selector: '.spinner', gone: true })).toContain('went away')
  })

  test('a selector that does not parse is an error, not a wait', async () => {
    const { tools } = page({ present: () => 'invalid' })
    await expect(tools.shown().wait({ selector: '##' })).rejects.toThrow(/Invalid selector/)
  })

  test('stops if the project closes while it waits', async () => {
    let live = true
    const present = () => {
      live = false
      return false
    }
    const { tools } = page({ live: () => live, present })
    await expect(tools.shown().wait({ selector: '#toast', ms: 2000 })).rejects.toThrow(
      /project was closed/,
    )
  })
})

test("a forced state's styles are what changed, and what went back to its default", () => {
  expect(
    changedStyles(
      { color: 'black', 'box-shadow': '0 0 1px red', cursor: 'pointer' },
      { color: 'red', cursor: 'pointer', outline: 'blue solid 2px' },
    ),
  ).toEqual({ color: 'red', 'box-shadow': 'initial', outline: 'blue solid 2px' })
})

describe("recording_timeline's header", () => {
  const clip = { id: 'c', width: 800, height: 600, durationMs: 1234.5, frameCount: 3 }
  test('a short clip lists every frame timestamp', () => {
    expect(describeClip({ ...clip, timestamps: [0, 33.4, 66.6] })).toBe(
      'Recording c: 800×600, 1235 ms, 3 frames (indexes 0–2).\nFrame timestamps (ms): 0, 33, 67',
    )
  })

  test('a long one gives the interval and its longest gaps instead', () => {
    const timestamps = Array.from({ length: 300 }, (_, i) => i * 100 + (i >= 150 ? 900 : 0))
    const header = describeClip({ ...clip, frameCount: 300, timestamps })
    expect(header).toContain('Frames come about every 100 ms.')
    expect(header).toContain('1000 ms after frame 149')
    expect(header).not.toContain('Frame timestamps')
  })
})
