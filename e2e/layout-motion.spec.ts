import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FOCUS_BAR_HEIGHT } from '../src/shared/layout'
import type { Rect, Viewport } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Layout changes resize the live preview into their new layout rather than jump it, the way
// dragging a window's edge would (src/main/preview-morph.ts, renderer app/layout-morph.ts):
// main springs the view's bounds and its emulated viewport on the display's frames, the page
// laying itself out again at every size on the way, and the chrome draws the device frame
// around it. These record the live view's bounds in main, the page's width in the preview, and
// what the chrome draws, every frame, as it happens.
//
// GUI_E2E_MORPH_FRAMES=<dir> also writes the window, as on screen, mid-morph there.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** Short enough for CI's screen. */
const WINDOW = { width: 1200, height: 800 }
/** Room for a jump across one dropped frame at the spring's fastest, and no more. */
const MAX_STEP = 150
/**
 * Over a longer gap between samples (CI's runner, without a GPU, is often late), the view may
 * cover more ground, but no faster than this, in px per ms: the springs step by real time, and
 * peak under 9 px/ms here (a change mid-morph, carrying its speed into the next). A jump is
 * several times faster.
 */
const MAX_SPEED = 12
/**
 * The drawer and the toolbar slide on the chrome's own spring, started when main's first frame
 * of the morph arrives, so their edge can trail the view's by about a frame at the spring's
 * fastest, and no more.
 */
const MAX_TRAIL = 32

interface MainStore {
  guiViewSamples?: ViewSample[]
  guiViewSampler?: NodeJS.Timeout
  guiViewStart?: number
  guiMark?: number
  guiMorphing?: Set<number>
}

/** Runs in main, in a task of its own: the preview view of the first window. */
async function liveView({ BrowserWindow, WebContentsView }: ElectronModule) {
  await new Promise<void>((resolve) => setImmediate(() => resolve()))
  const win = BrowserWindow.getAllWindows()[0]
  const view = win?.contentView.children.find(
    (child): child is InstanceType<typeof WebContentsView> =>
      child instanceof WebContentsView && /^https?:\/\//.test(child.webContents.getURL()),
  )
  if (!win || !view) return null
  const [width = 0, height = 0] = win.getContentSize()
  const morphing = ((globalThis as unknown as MainStore).guiMorphing?.size ?? 0) > 0
  return {
    bounds: view.getBounds(),
    visible: view.getVisible(),
    morphing,
    content: { width, height },
  }
}

function setContentSize(
  { BrowserWindow }: ElectronModule,
  size: { width: number; height: number },
) {
  BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
}

interface ViewSample {
  t: number
  bounds: Rect
  visible: boolean
  /** The chat view, while it shows */
  chat: Rect | null
}

/** Runs in main: records the preview view's bounds every 4 ms until `stopSampling`. */
function startSampling({ BrowserWindow, WebContentsView }: ElectronModule) {
  const store = globalThis as unknown as MainStore
  const win = BrowserWindow.getAllWindows()[0]
  const view = win?.contentView.children.find(
    (child): child is InstanceType<typeof WebContentsView> =>
      child instanceof WebContentsView && /^https?:\/\//.test(child.webContents.getURL()),
  )
  if (!view) throw new Error('No preview view')
  const chat = win?.contentView.children.find(
    (child): child is InstanceType<typeof WebContentsView> =>
      child instanceof WebContentsView && child.webContents.getURL().endsWith('/chat.html'),
  )
  const samples: ViewSample[] = []
  const start = performance.now()
  store.guiViewSamples = samples
  store.guiViewStart = start
  store.guiMark = undefined
  const sample = () => {
    const t = performance.now() - start
    const chatBounds = chat?.getVisible() ? chat.getBounds() : null
    samples.push({ t, bounds: view.getBounds(), visible: view.getVisible(), chat: chatBounds })
  }
  // One now: an instant change can land before the first interval.
  sample()
  store.guiViewSampler = setInterval(sample, 4)
}

function stopSampling() {
  const store = globalThis as unknown as MainStore
  if (store.guiViewSampler) clearInterval(store.guiViewSampler)
  return { samples: store.guiViewSamples ?? [], mark: store.guiMark ?? null }
}

/** Runs in main: notes when (on the sampler's clock) the next change was asked for. */
function markNow() {
  const store = globalThis as unknown as MainStore
  store.guiMark = performance.now() - (store.guiViewStart ?? 0)
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface ChromeFrame {
  /** The device frame's edge the chrome draws around the view mid-morph */
  edge: { box: Box; opacity: number } | null
  /** Where main last said the view is, mid-morph */
  view: Box | null
  /** The drawer, and the bars above the canvas, as drawn */
  drawer: Box | null
  bars: { box: Box; opacity: number } | null
}

interface ChromeStore {
  guiFrames?: ChromeFrame[]
  guiRecording?: boolean
  /** The morph events main sent since recording started, and how to stop listening */
  guiMorphs?: string[]
  guiMorphsOff?: () => void
}

/** Runs in the chrome page: records the morph and what moves with it, every frame. */
function startRecording() {
  const store = globalThis as unknown as ChromeStore
  const frames: ChromeFrame[] = []
  store.guiFrames = frames
  store.guiRecording = true
  const morphs: string[] = []
  store.guiMorphs = morphs
  let view: Box | null = null
  store.guiMorphsOff?.()
  store.guiMorphsOff = window.gui.onMorph((event) => {
    morphs.push(event.type)
    view = event.type === 'frame' ? event.rect : null
  })
  const rect = (el: Element | null) => {
    if (!el) return null
    const { x, y, width, height } = el.getBoundingClientRect()
    return { x, y, width, height }
  }
  const record = () => {
    const edge = document.querySelector<HTMLElement>('[data-morph-frame]')
    const bars =
      document.querySelector('[aria-label^="Viewport: "]')?.closest('header')?.parentElement ?? null
    const drawerBox = rect(document.querySelector('section[aria-label="Terminal"]'))
    frames.push({
      edge: edge
        ? {
            box: rect(edge) ?? { x: 0, y: 0, width: 0, height: 0 },
            opacity: Number(edge.style.opacity || 1),
          }
        : null,
      view,
      drawer: drawerBox && drawerBox.height > 0 ? drawerBox : null,
      bars: bars
        ? {
            box: rect(bars) ?? { x: 0, y: 0, width: 0, height: 0 },
            opacity: Number(getComputedStyle(bars).opacity),
          }
        : null,
    })
    if (store.guiRecording) requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
}

function stopRecording() {
  const store = globalThis as unknown as ChromeStore
  store.guiRecording = false
  store.guiMorphsOff?.()
  store.guiMorphsOff = undefined
  return { frames: store.guiFrames ?? [], morphs: store.guiMorphs ?? [] }
}

interface PageStore {
  guiWidths?: number[]
  guiWidthsRecording?: boolean
}

/** Runs in the preview's page: the width the page is laid out at, every frame. */
function startWidths() {
  const store = globalThis as unknown as PageStore
  const widths: number[] = []
  store.guiWidths = widths
  store.guiWidthsRecording = true
  const record = () => {
    if (widths.at(-1) !== innerWidth) widths.push(innerWidth)
    if (store.guiWidthsRecording) requestAnimationFrame(record)
  }
  record()
}

function stopWidths() {
  const store = globalThis as unknown as PageStore
  store.guiWidthsRecording = false
  return store.guiWidths ?? []
}

/** Runs in the chrome page: a morph has come and gone since recording started. */
function morphOver() {
  const events = (globalThis as unknown as ChromeStore).guiMorphs ?? []
  return events.includes('pending') && events.at(-1) === 'end'
}

const EVIDENCE = process.env.GUI_E2E_MORPH_FRAMES
/** When the window is grabbed, in ms after the change is asked for. */
const EVIDENCE_AT = [40, 90, 140, 200, 280, 400]

/**
 * With GUI_E2E_MORPH_FRAMES set, grabs the window while `act` runs: macOS's own composite of
 * it (`screencapture -l`, by its window id), the chrome and the native views as they're on
 * screen together.
 */
async function withEvidence<T>(session: GuiSession, name: string, act: () => Promise<T>) {
  if (!EVIDENCE) return act()
  const source = await session.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getMediaSourceId(),
  )
  const id = source?.split(':')[1]
  if (!id) throw new Error('No window id')
  mkdirSync(EVIDENCE, { recursive: true })
  const start = Date.now()
  const grabs = EVIDENCE_AT.map(async (at) => {
    await sleep(at - (Date.now() - start))
    const file = join(EVIDENCE, `${name}-${String(Date.now() - start).padStart(3, '0')}ms.png`)
    await new Promise((done) => execFile('screencapture', ['-x', '-o', `-l${id}`, file], done))
  })
  const [result] = await Promise.all([act(), ...grabs])
  console.log(`[e2e] ${EVIDENCE_AT.length} frames of "${name}" in ${EVIDENCE}`)
  return result
}

/** The canvas as the chrome lays it out, in window coordinates. */
function canvasRect(session: GuiSession): Promise<Rect> {
  return session.chrome.evaluate(() => {
    const main = document.querySelector('main')
    if (!main) throw new Error('No canvas')
    const { x, y, width, height } = main.getBoundingClientRect()
    return { x, y, width, height }
  })
}

/** Where main lays the preview out now: its device frame, or the canvas (right of a sidebar). */
async function placement(session: GuiSession): Promise<Rect> {
  const state = await session.state()
  const canvas = await canvasRect(session)
  const frame = state.preview.frame
  if (frame) {
    return {
      x: Math.round(frame.rect.x + canvas.x),
      y: Math.round(frame.rect.y + canvas.y),
      width: frame.rect.width,
      height: frame.rect.height,
    }
  }
  // The chrome lays the canvas out right of the chat sidebar already.
  return {
    x: Math.round(canvas.x),
    y: Math.round(canvas.y),
    width: Math.round(canvas.width),
    height: Math.round(canvas.height),
  }
}

const same = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

const near = (a: Box | null | undefined, b: Rect, slack = 1.5) =>
  !!a &&
  Math.abs(a.x - b.x) <= slack &&
  Math.abs(a.y - b.y) <= slack &&
  Math.abs(a.width - b.width) <= slack &&
  Math.abs(a.height - b.height) <= slack

/**
 * Waits for the morph to be over: main done with it, the live view visible at exactly where
 * main lays the preview out, and no device frame of the morph's left in the chrome.
 */
async function landed(
  session: GuiSession,
  label: string,
  { timeout = 10_000, morph = false }: { timeout?: number; morph?: boolean } = {},
) {
  return waitFor(
    async () => {
      if (morph && !(await session.chrome.evaluate(morphOver))) return null
      const view = await session.app.evaluate(liveView)
      const expected = await placement(session)
      if (!view?.visible || view.morphing || !same(view.bounds, expected)) return null
      const morphs = await session.chrome.locator('[data-morph]').count()
      return morphs === 0 ? { view, expected } : null
    },
    label,
    { timeout, interval: 30 },
  )
}

interface Recording {
  frames: ChromeFrame[]
  morphs: string[]
  samples: ViewSample[]
  mark: number | null
  /** The distinct widths the page was laid out at, in order */
  widths: number[]
}

/** Records the live view, the page and the chrome while `act` runs and the morph lands. */
async function record(
  session: GuiSession,
  act: () => Promise<unknown>,
  label: string,
  { morph = true }: { morph?: boolean } = {},
): Promise<Recording & { end: Awaited<ReturnType<typeof landed>> }> {
  const preview = await session.previewPage()
  await preview.evaluate(startWidths)
  await session.app.evaluate(startSampling)
  await session.chrome.evaluate(startRecording)
  const end = await act().then(() => landed(session, label, { morph }))
  // A little longer: nothing may move once it has landed.
  await sleep(150)
  const { frames, morphs } = await session.chrome.evaluate(stopRecording)
  const { samples, mark } = await session.app.evaluate(stopSampling)
  const widths = await preview.evaluate(stopWidths)
  return { frames, morphs, samples, mark, widths, end }
}

/** The live view's distinct bounds, in order, each with when it was first seen. */
function viewPath(samples: ViewSample[]) {
  const path: (Rect & { t: number; visible: boolean })[] = []
  for (const { t, bounds, visible } of samples) {
    const last = path.at(-1)
    if (last && same(last, bounds) && last.visible === visible) continue
    path.push({ t, visible, ...bounds })
  }
  return path
}

/**
 * The steps from one of the view's bounds to the next that move further than the spring
 * could in the time between them: none, for a continuous resize. Logs the largest step.
 */
/** The chat view's distinct bounds, in order, while it shows. */
function chatPath(samples: ViewSample[]) {
  const path: (Rect & { t: number })[] = []
  for (const { t, chat } of samples) {
    if (!chat || near(path.at(-1), chat, 0)) continue
    path.push({ ...chat, t })
  }
  return path
}

function jumps(path: (Rect & { t: number })[], label: string) {
  const found: { t: number; ms: number; step: number }[] = []
  let largest = { step: 0, ms: 0 }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    if (!a || !b) continue
    const step = Math.max(
      Math.abs(a.x - b.x),
      Math.abs(a.y - b.y),
      Math.abs(a.width - b.width),
      Math.abs(a.height - b.height),
    )
    // The sampler sees a step up to its interval after it happened.
    const ms = b.t - a.t + 4
    if (step > largest.step) largest = { step, ms }
    if (step >= Math.max(MAX_STEP, MAX_SPEED * ms)) {
      found.push({ t: Math.round(b.t), ms: Math.round(ms), step: Math.round(step) })
    }
  }
  console.log(
    `[e2e] ${label}: ${path.length} sizes, largest step ${Math.round(largest.step)} px ` +
      `over ${Math.round(largest.ms)} ms`,
  )
  return found
}

/** Never back the way it came: each value no further from `to` than the one before. */
function monotonic(values: number[], to: number, slack = 0.5) {
  return values.every(
    (value, i) =>
      i === 0 || Math.abs(value - to) <= Math.abs((values[i - 1] ?? value) - to) + slack,
  )
}

async function setViewport(session: GuiSession, viewport: Viewport) {
  await session.chrome.evaluate((id) => window.gui.setViewport(id), viewport)
}

/** The app at WINDOW's size on Desktop, at rest. */
async function ready(session: GuiSession) {
  await session.waitForPreview()
  await session.app.evaluate(setContentSize, WINDOW)
  return landed(session, 'the preview at the test size')
}

test('a viewport switch resizes the live page from the old frame to the new one', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { view: desktop } = await ready(session)

  const { frames, samples, widths, end } = await withEvidence(session, 'desktop-to-mobile', () =>
    record(session, () => setViewport(session, 'mobile'), 'the mobile frame, landed'),
  )
  const mobile = end.expected
  expect(mobile.width).toBeLessThan(desktop.bounds.width / 2)

  // The view itself moved, on screen the whole way, over many frames without jumping, from the
  // desktop preview to exactly the mobile frame.
  const path = viewPath(samples)
  expect(path.length).toBeGreaterThan(6)
  expect(path.every((step) => step.visible)).toBe(true)
  expect(near(path[0], desktop.bounds, 0)).toBe(true)
  expect(near(path.at(-1), mobile, 0)).toBe(true)
  expect(jumps(path, 'desktop to mobile')).toEqual([])
  // Critically damped: it narrows all the way without widening again.
  expect(
    monotonic(
      path.map((step) => step.width),
      mobile.width,
    ),
  ).toBe(true)
  const between = path.filter(
    (step) => step.width < desktop.bounds.width - 40 && step.width > mobile.width + 40,
  )
  expect(between.length).toBeGreaterThan(2)

  // The page laid itself out at sizes on the way, like a window being resized, and is a
  // phone's now.
  const reflowed = widths.filter((width) => width < desktop.bounds.width - 40 && width > 430)
  console.log(`[e2e] the page laid out at ${widths.length} widths on the way to the phone`)
  expect(reflowed.length).toBeGreaterThan(2)
  expect(monotonic(widths, 390, 1)).toBe(true)
  expect(widths.at(-1)).toBe(390)

  // The device frame's edge came in around it.
  const edges = frames.flatMap((frame) => (frame.edge ? [frame.edge.opacity] : []))
  expect(edges.some((opacity) => opacity > 0.05 && opacity < 0.95)).toBe(true)
})

test('a change mid-morph carries on from where the view is', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  const { view: desktop } = await ready(session)

  const { samples, mark, end } = await record(
    session,
    async () => {
      await setViewport(session, 'mobile')
      // Mid-flight: the view has narrowed by a good part of the way.
      await waitFor(
        async () => {
          const view = await session.app.evaluate(liveView)
          const width = view?.bounds.width ?? desktop.bounds.width
          return width < desktop.bounds.width * 0.8 && width > desktop.bounds.width * 0.45
        },
        'the view mid-morph',
        { timeout: 5_000, interval: 5 },
      )
      await session.app.evaluate(markNow)
      await setViewport(session, 'tablet')
    },
    'the tablet frame, landed',
  )
  if (mark === null) throw new Error('No mark')
  const tablet = end.expected
  const path = viewPath(samples)
  const before = path.filter((step) => step.t <= mark)
  const after = path.filter((step) => step.t > mark)
  expect(before.length).toBeGreaterThan(2)
  expect(after.length).toBeGreaterThan(4)
  // Continuous through the change: no jump back to where it started, or anywhere else.
  expect(jumps(path, 'mobile, then tablet mid-morph')).toEqual([])
  expect(after.some((step) => near(step, desktop.bounds, 20))).toBe(false)
  expect(near(path.at(-1), tablet, 0)).toBe(true)
})

test('the drawer slides with the preview it pushes, and both land exactly', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  const { view: desktop } = await ready(session)

  // The drawer's top against the view's bottom, each frame both moved.
  const trail = (frames: ChromeFrame[]) =>
    frames.flatMap((frame) =>
      frame.view && frame.drawer
        ? [Math.abs(frame.drawer.y - (frame.view.y + frame.view.height))]
        : [],
    )

  // Opening: the page gets shorter as the drawer rises with its edge.
  const open = await withEvidence(session, 'drawer-open', () =>
    record(
      session,
      () => session.chrome.evaluate(() => window.gui.setDrawerOpen(true)),
      'the preview above the open drawer',
    ),
  )
  const shorter = open.end.expected
  expect(shorter.height).toBeLessThan(desktop.bounds.height - 100)
  expect(shorter.width).toBe(desktop.bounds.width)
  const rising = viewPath(open.samples)
  expect(rising.length).toBeGreaterThan(5)
  expect(near(rising[0], desktop.bounds, 0)).toBe(true)
  expect(near(rising.at(-1), shorter, 0)).toBe(true)
  expect(jumps(rising, 'drawer opening')).toEqual([])
  // Only its height changes: its top and sides stay put, the page laid out at its width.
  for (const step of rising) {
    expect(step.x).toBe(desktop.bounds.x)
    expect(step.y).toBe(desktop.bounds.y)
    expect(step.width).toBe(desktop.bounds.width)
  }
  const gapsOpen = trail(open.frames)
  expect(gapsOpen.length).toBeGreaterThan(5)
  console.log(`[e2e] drawer opening: its edge at most ${Math.round(Math.max(...gapsOpen))} px off`)
  expect(Math.max(...gapsOpen)).toBeLessThan(MAX_TRAIL)
  // The floating chat in its bottom corner rises with the drawer, rather than jumping the
  // drawer's height when the canvas changes.
  const chatRising = chatPath(open.samples)
  expect(chatRising.length).toBeGreaterThan(5)
  expect(chatRising.at(-1)?.y ?? 0).toBeLessThan(chatRising[0]?.y ?? 0)
  expect(jumps(chatRising, 'chat over the opening drawer')).toEqual([])

  // Closing: the drawer goes down and the page's edge follows it.
  const close = await withEvidence(session, 'drawer-close', () =>
    record(
      session,
      () => session.chrome.evaluate(() => window.gui.setDrawerOpen(false)),
      'the preview filling the canvas again',
    ),
  )
  expect(close.end.expected).toEqual(desktop.bounds)
  const falling = viewPath(close.samples)
  expect(falling.length).toBeGreaterThan(5)
  expect(near(falling[0], shorter, 0)).toBe(true)
  expect(near(falling.at(-1), desktop.bounds, 0)).toBe(true)
  expect(jumps(falling, 'drawer closing')).toEqual([])
  const gapsClose = trail(close.frames)
  expect(gapsClose.length).toBeGreaterThan(5)
  console.log(`[e2e] drawer closing: its edge at most ${Math.round(Math.max(...gapsClose))} px off`)
  expect(Math.max(...gapsClose)).toBeLessThan(MAX_TRAIL)
  // And comes back down with it, not over the drawer still on its way out.
  const chatFalling = chatPath(close.samples)
  expect(chatFalling.length).toBeGreaterThan(5)
  expect(chatFalling.at(-1)?.y ?? 0).toBeGreaterThan(chatFalling[0]?.y ?? 0)
  expect(jumps(chatFalling, 'chat over the closing drawer')).toEqual([])
  // The drawer is gone from the layout, with nothing left of its slide.
  const drawer = await session.chrome.evaluate(() => {
    const section = document.querySelector<HTMLElement>('section[aria-label="Terminal"]')
    return section ? { height: section.offsetHeight, transform: section.style.transform } : null
  })
  expect(drawer?.height).toBeLessThanOrEqual(1)
  expect(drawer?.transform).toBe('')
})

test('zoom steps, focus mode and docking resize the page, and land on their exact layout', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { view: desktop } = await ready(session)

  // Zoom in on Desktop: the view stays, and the page lays out narrower and narrower inside it
  // as it's drawn larger, like a browser zooming smoothly.
  const zoom = await withEvidence(session, 'zoom-in', () =>
    record(session, () => session.chrome.evaluate(() => window.gui.zoomPreview(1)), 'zoomed in'),
  )
  expect(zoom.end.expected).toEqual(desktop.bounds)
  expect(viewPath(zoom.samples).length).toBe(1)
  const zoomed = Math.round(desktop.bounds.width / 1.1)
  const zooming = zoom.widths.filter(
    (width) => width < desktop.bounds.width - 5 && width > zoomed + 5,
  )
  expect(zooming.length).toBeGreaterThan(1)
  expect(Math.abs((zoom.widths.at(-1) ?? 0) - zoomed)).toBeLessThanOrEqual(1)
  expect((await session.state()).preview.zoom).toBe(1.1)
  await record(session, () => session.chrome.evaluate(() => window.gui.zoomPreview(0)), 'at 100%')
  expect((await session.state()).preview.zoom).toBe(1)

  // Focus mode: the preview grows up into the toolbar's room as the bars fade and slide away.
  const focus = await withEvidence(session, 'focus-enter', () =>
    record(session, () => session.chrome.evaluate(() => window.gui.setFocusMode(true)), 'focused'),
  )
  expect(focus.end.expected.y).toBe(FOCUS_BAR_HEIGHT)
  const growing = viewPath(focus.samples)
  expect(growing.length).toBeGreaterThan(5)
  expect(near(growing[0], desktop.bounds, 0)).toBe(true)
  expect(near(growing.at(-1), focus.end.expected, 0)).toBe(true)
  expect(jumps(growing, 'focus mode')).toEqual([])
  const bars = focus.frames.flatMap((frame) => (frame.bars ? [frame.bars.opacity] : []))
  expect(bars.some((opacity) => opacity > 0.05 && opacity < 0.95)).toBe(true)

  const unfocus = await withEvidence(session, 'focus-exit', () =>
    record(
      session,
      () => session.chrome.evaluate(() => window.gui.setFocusMode(false)),
      'out of focus mode',
    ),
  )
  expect(unfocus.end.expected).toEqual(desktop.bounds)
  expect(viewPath(unfocus.samples).length).toBeGreaterThan(5)

  // The chat as the sidebar: the page narrows as it slides in.
  const dock = await withEvidence(session, 'dock', () =>
    record(session, () => session.chat.evaluate(() => window.gui.toggleDock()), 'docked'),
  )
  expect(dock.end.expected.width).toBeLessThan(desktop.bounds.width - 200)
  const narrowing = viewPath(dock.samples)
  expect(narrowing.length).toBeGreaterThan(5)
  expect(near(narrowing.at(-1), dock.end.expected, 0)).toBe(true)
  expect(jumps(narrowing, 'docking')).toEqual([])
  expect(dock.widths.length).toBeGreaterThan(3)
  // The sidebar slid in from past the window's left edge, rather than appearing.
  const docked = dock.samples.flatMap((sample) => (sample.chat ? [sample.chat.x] : []))
  const slid = docked.filter((x, i) => i === 0 || x !== docked[i - 1])
  const sidebarWidth = dock.end.expected.x
  expect(slid.filter((x) => x < -20 && x > -sidebarWidth + 20).length).toBeGreaterThan(3)
  expect(slid.at(-1)).toBe(0)
  const undock = await record(
    session,
    () => session.chat.evaluate(() => window.gui.toggleDock()),
    'floating again',
  )
  expect(undock.end.expected).toEqual(desktop.bounds)
})

test('with Reduce motion on, the preview changes in place and nothing slides', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  const { view: desktop } = await ready(session)

  const { frames, morphs, samples, widths, end } = await withEvidence(
    session,
    'reduced-mobile',
    () =>
      record(session, () => setViewport(session, 'mobile'), 'the mobile frame', { morph: false }),
  )
  // Straight from one layout to the other: no sizes between, for the view or the page.
  expect(viewPath(samples).map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
    desktop.bounds,
    end.expected,
  ])
  // The page itself may see the view's new size for a frame before its emulation applies.
  expect(widths.length).toBeLessThanOrEqual(3)
  expect(widths.at(-1)).toBe(390)
  expect(morphs).toEqual([])
  expect(frames.some((frame) => frame.edge)).toBe(false)

  // The drawer fades in place rather than sliding.
  const drawer = await record(
    session,
    () => session.chrome.evaluate(() => window.gui.setDrawerOpen(true)),
    'the drawer open',
    { morph: false },
  )
  const tops = new Set(drawer.frames.flatMap((frame) => (frame.drawer ? [frame.drawer.y] : [])))
  expect(tops.size).toBe(1)
})
