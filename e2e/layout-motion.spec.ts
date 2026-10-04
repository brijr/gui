import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FOCUS_BAR_HEIGHT } from '../src/shared/layout'
import type { Rect, Viewport } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Layout changes morph the preview rather than jump it (src/main/preview-morph.ts, renderer
// app/layout-morph.ts): main captures the preview, the chrome draws that snapshot and springs it
// from the old layout to the new one while the live view waits out of sight at its new layout,
// then the live view comes back in place and the snapshot goes. These record the snapshot every
// frame in the chrome and the live view's bounds in main as it happens.
//
// GUI_E2E_MORPH_FRAMES=<dir> also writes the window, as on screen, mid-morph there.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** Short enough for CI's screen. */
const WINDOW = { width: 1200, height: 800 }
/**
 * A change whose snapshot takes longer than 40 ms is instant (preview-morph.ts). CI's runner,
 * without a GPU, captures slower than that, so these give it longer; the last test checks the
 * instant change itself.
 */
const MORPHING = { GUI_E2E_CAPTURE_BUDGET_MS: '2000' }
/** Room for a jump across one dropped frame at the spring's fastest, and no more. */
const MAX_STEP = 150
/**
 * Over a longer gap between drawn frames (CI's runner, without a GPU, drops several), the
 * snapshot may cover more ground, but no faster than this, in px per ms. The spring is solved
 * for the time elapsed, and peaks under 6 px/ms for the largest change here (desktop to mobile,
 * 884 px narrower); anything faster is a jump.
 */
const MAX_SPEED = 8

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
  return { bounds: view.getBounds(), visible: view.getVisible(), content: { width, height } }
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

interface MainStore {
  guiViewSamples?: ViewSample[]
  guiViewSampler?: NodeJS.Timeout
  guiMorphTimings?: { capture: number; wait: number; encode: number }[]
  guiMorphFallbacks?: { reason: string; capture?: number }[]
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
  const sample = () => {
    const t = Math.round(performance.now() - start)
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
  return store.guiViewSamples ?? []
}

/** Runs in main: how long each snapshot took (preview-morph.ts keeps them in unpackaged builds). */
function captureTimings() {
  return (globalThis as unknown as MainStore).guiMorphTimings ?? []
}

/** Runs in main: why each instant change didn't morph. */
function captureFallbacks() {
  return (globalThis as unknown as MainStore).guiMorphFallbacks ?? []
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface ChromeFrame {
  t: number
  /** The snapshot's clip box, as drawn */
  box: Box | null
  /** Its pictures, bottom to top: opacity and drawn width */
  layers: { opacity: number; width: number }[]
  /** The device frame's edge it draws */
  edge: { box: Box; opacity: number } | null
  /** The drawer, and the bars above the canvas, as drawn */
  drawer: Box | null
  bars: { box: Box; opacity: number } | null
}

interface ChromeStore {
  guiFrames?: ChromeFrame[]
  guiRecording?: boolean
  guiMark?: number
  /** The morph events main sent since recording started, and how to stop listening */
  guiMorphs?: { type: string; reduced?: boolean }[]
  guiMorphsOff?: () => void
}

/** Runs in the chrome page: records the morph and what moves with it, every frame. */
function startRecording() {
  const store = globalThis as unknown as ChromeStore
  const frames: ChromeFrame[] = []
  const start = performance.now()
  store.guiFrames = frames
  store.guiRecording = true
  store.guiMark = undefined
  const morphs: { type: string; reduced?: boolean }[] = []
  store.guiMorphs = morphs
  store.guiMorphsOff?.()
  store.guiMorphsOff = window.gui.onMorph((event) => {
    morphs.push({
      type: event.type,
      reduced: event.type === 'snapshot' ? event.reduced : undefined,
    })
  })
  const rect = (el: Element | null) => {
    if (!el) return null
    const { x, y, width, height } = el.getBoundingClientRect()
    return { x, y, width, height }
  }
  const record = () => {
    const box = document.querySelector('[data-morph-snapshot]')
    const edge = document.querySelector<HTMLElement>('[data-morph-frame]')
    const bars =
      document.querySelector('[aria-label="Viewport"]')?.closest('header')?.parentElement ?? null
    const drawer = document.querySelector('section[aria-label="Terminal"]')
    const layers = [...(box?.querySelectorAll('canvas') ?? [])].map((img) => ({
      opacity: Number(getComputedStyle(img).opacity),
      width: img.getBoundingClientRect().width,
    }))
    const drawerBox = rect(drawer)
    frames.push({
      t: performance.now() - start,
      box: rect(box),
      layers,
      edge: edge
        ? {
            box: rect(edge) ?? { x: 0, y: 0, width: 0, height: 0 },
            opacity: Number(edge.style.opacity || 1),
          }
        : null,
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
  return start
}

function stopRecording() {
  const store = globalThis as unknown as ChromeStore
  store.guiRecording = false
  store.guiMorphsOff?.()
  store.guiMorphsOff = undefined
  return { frames: store.guiFrames ?? [], mark: store.guiMark ?? null }
}

/**
 * Runs in the chrome page: a morph has come and gone since recording started. Main's `end`
 * closes it, or with Reduce motion (which never moves the view, so main doesn't end it) the
 * snapshot's fade having finished.
 */
function morphOver() {
  const events = (globalThis as unknown as ChromeStore).guiMorphs ?? []
  if (!events.some((event) => event.type === 'pending')) return false
  if (document.querySelector('[data-morph]')) return false
  const last = events.at(-1)?.type
  const reduced = events.some((event) => event.reduced === true)
  return last === 'end' || (reduced && last === 'target')
}

/** Runs in the chrome page: notes when (on the recording's clock) the next change was asked for. */
function markNow(start: number) {
  ;(globalThis as unknown as ChromeStore).guiMark = performance.now() - start
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

/** Where main lays the preview out now: its device frame, or the canvas (less a docked chat). */
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
  const chat = await session.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
      (child): child is InstanceType<typeof WebContentsView> =>
        child instanceof WebContentsView && child.webContents.getURL().endsWith('/chat.html'),
    )
    return view?.getVisible() ? view.getBounds() : null
  })
  const docked = (await session.chatSnapshot()).meta.docked && chat !== null
  const width = docked && chat ? chat.x - Math.round(canvas.x) : Math.round(canvas.width)
  return {
    x: Math.round(canvas.x),
    y: Math.round(canvas.y),
    width,
    height: Math.round(canvas.height),
  }
}

const same = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

const near = (a: Box | null, b: Rect, slack = 1.5) =>
  a !== null &&
  Math.abs(a.x - b.x) <= slack &&
  Math.abs(a.y - b.y) <= slack &&
  Math.abs(a.width - b.width) <= slack &&
  Math.abs(a.height - b.height) <= slack

/**
 * Waits for the morph to be over: the live view visible at exactly where main lays the preview
 * out, and no snapshot left in the chrome.
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
      if (!view?.visible || !same(view.bounds, expected)) return null
      const morphs = await session.chrome.locator('[data-morph]').count()
      return morphs === 0 ? { view, expected } : null
    },
    label,
    { timeout, interval: 30 },
  )
}

interface Recording {
  frames: ChromeFrame[]
  mark: number | null
  samples: ViewSample[]
}

/** Records the chrome's frames and the live view's bounds while `act` runs and the morph lands. */
async function record(
  session: GuiSession,
  act: (start: number) => Promise<unknown>,
  label: string,
): Promise<Recording & { end: Awaited<ReturnType<typeof landed>> }> {
  await session.app.evaluate(startSampling)
  const start = await session.chrome.evaluate(startRecording)
  const end = await act(start).then(() => landed(session, label, { morph: true }))
  // A little longer: nothing may move once it has landed.
  await sleep(150)
  const { frames, mark } = await session.chrome.evaluate(stopRecording)
  const samples = await session.app.evaluate(stopSampling)
  return { frames, mark, samples, end }
}

/** The snapshot's rects, each once, in order. */
function boxes(frames: ChromeFrame[]) {
  const all = frames.flatMap((frame) => (frame.box ? [{ t: frame.t, ...frame.box }] : []))
  return all.filter((box, i) => {
    const last = all[i - 1]
    return (
      !last ||
      Math.abs(box.x - last.x) > 0.05 ||
      Math.abs(box.y - last.y) > 0.05 ||
      Math.abs(box.width - last.width) > 0.05 ||
      Math.abs(box.height - last.height) > 0.05
    )
  })
}

/**
 * The steps from one drawn rect to the next that move further than the spring could in the time
 * between them: none, for a continuous morph. Logs the largest step, and the gap it spanned.
 */
function jumps(path: (Box & { t: number })[], label: string) {
  const found: { t: number; gap: number; step: number }[] = []
  let largest = { step: 0, gap: 0 }
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
    const gap = b.t - a.t
    if (step > largest.step) largest = { step, gap }
    if (step >= Math.max(MAX_STEP, MAX_SPEED * gap)) found.push({ t: Math.round(b.t), gap, step })
  }
  console.log(
    `[e2e] ${label}: largest step ${Math.round(largest.step)} px over ${Math.round(largest.gap)} ms`,
  )
  return found
}

/** The live view's distinct bounds, in order, and whether each was out of sight. */
function viewPath(samples: ViewSample[], contentHeight: number) {
  const path: { bounds: Rect; outOfSight: boolean; visible: boolean }[] = []
  for (const { bounds, visible } of samples) {
    const last = path.at(-1)
    if (last && same(last.bounds, bounds) && last.visible === visible) continue
    const outOfSight = bounds.x === 1 - bounds.width && bounds.y === contentHeight - 1
    path.push({ bounds, outOfSight, visible })
  }
  return path
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

const latency = { capture: [] as number[], wait: [] as number[], encode: [] as number[] }

async function collectTimings(session: GuiSession) {
  for (const timing of await session.app.evaluate(captureTimings)) {
    latency.capture.push(timing.capture)
    latency.wait.push(timing.wait)
    latency.encode.push(timing.encode)
  }
}

/** The sessions the running test launched, for its log if it fails. */
const launched: GuiSession[] = []
function tracked(session: GuiSession) {
  launched.push(session)
  return session
}

// A failure says why its morph fell back, if it did (CI captures slower than a Mac with a GPU).
test.afterEach(async ({ keepTemp: _keepTemp }, testInfo) => {
  const sessions = launched.splice(0)
  if (testInfo.status === testInfo.expectedStatus) return
  for (const session of sessions) {
    const fallbacks = await session.app.evaluate(captureFallbacks).catch(() => [])
    console.log(`[e2e] morphs that fell back: ${JSON.stringify(fallbacks)}`)
  }
})

test.afterAll(() => {
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const fixed = (value: number) => Number(value.toFixed(1))
    return `min ${fixed(sorted[0] ?? 0)} / median ${fixed(median)} / max ${fixed(sorted.at(-1) ?? 0)} ms`
  }
  if (latency.capture.length === 0) return
  console.log(
    `[e2e] preview snapshots (${latency.capture.length}): capturePage ${stats(latency.capture)}; ` +
      `asked to captured ${stats(latency.wait)}; JPEG ${stats(latency.encode)}`,
  )
})

test('a viewport switch morphs a snapshot from the old frame to the new one', async ({
  launch,
}) => {
  const session = tracked(await launch({ fixture: 'vite', env: MORPHING }))
  const { view: desktop } = await ready(session)
  const captures = (await session.app.evaluate(captureTimings)).length

  const { frames, samples, end } = await withEvidence(session, 'desktop-to-mobile', () =>
    record(session, () => setViewport(session, 'mobile'), 'the mobile frame, landed'),
  )
  const mobile = end.expected
  expect(mobile.width).toBeLessThan(desktop.bounds.width / 2)

  // The snapshot started where the desktop preview was, moved over many frames without
  // jumping, and came to rest exactly on the mobile frame.
  const path = boxes(frames)
  expect(path.length).toBeGreaterThan(6)
  expect(near(path[0] ?? null, desktop.bounds)).toBe(true)
  expect(near(path.at(-1) ?? null, mobile)).toBe(true)
  expect(jumps(path, 'desktop to mobile')).toEqual([])
  // Critically damped: it narrows all the way without widening again.
  for (let i = 1; i < path.length; i++) {
    expect(path[i]?.width ?? 0).toBeLessThanOrEqual((path[i - 1]?.width ?? 0) + 0.5)
  }
  const between = path.filter(
    (box) => box.width < desktop.bounds.width - 40 && box.width > mobile.width + 40,
  )
  expect(between.length).toBeGreaterThan(2)
  // The device frame's edge came in with it; and the page's new layout cross-faded in under the
  // old picture while it moved.
  const edges = frames.flatMap((frame) => (frame.edge ? [frame.edge.opacity] : []))
  expect(edges.some((opacity) => opacity > 0.05 && opacity < 0.95)).toBe(true)
  expect(frames.some((frame) => frame.layers.length === 2)).toBe(true)

  // The live view: in place until the snapshot showed, then out of sight at its new size, then
  // back exactly where main lays it out. Never on screen anywhere in between.
  const live = viewPath(samples, desktop.content.height)
  expect(live[0]?.bounds).toEqual(desktop.bounds)
  expect(live.at(-1)?.bounds).toEqual(mobile)
  expect(live.every((step) => step.visible)).toBe(true)
  const middle = live.slice(1, -1)
  expect(middle.length).toBeGreaterThan(0)
  for (const step of middle) {
    expect(step.outOfSight).toBe(true)
    expect(step.bounds.width).toBe(mobile.width)
    expect(step.bounds.height).toBe(mobile.height)
  }
  // One snapshot, and the page is a phone's.
  expect((await session.app.evaluate(captureTimings)).length).toBe(captures + 1)
  const preview = await session.previewPage()
  expect(await preview.evaluate(() => innerWidth)).toBe(390)
  await collectTimings(session)
})

test('a change mid-morph carries on from where the snapshot is, without capturing again', async ({
  launch,
}) => {
  const session = tracked(await launch({ fixture: 'vite', env: MORPHING }))
  const { view: desktop } = await ready(session)
  const captures = (await session.app.evaluate(captureTimings)).length

  const { frames, mark, end } = await record(
    session,
    async (start) => {
      await setViewport(session, 'mobile')
      // Mid-flight: the snapshot has narrowed by a good part of the way.
      await waitFor(
        () =>
          session.chrome.evaluate((width) => {
            const box = document.querySelector('[data-morph-snapshot]')
            const now = box?.getBoundingClientRect().width ?? width
            return now < width * 0.8 && now > width * 0.45
          }, desktop.bounds.width),
        'the snapshot mid-morph',
        { timeout: 5_000, interval: 5 },
      )
      await session.chrome.evaluate(markNow, start)
      await setViewport(session, 'tablet')
    },
    'the tablet frame, landed',
  )
  if (mark === null) throw new Error('No mark')
  const tablet = end.expected
  const path = boxes(frames)
  const after = path.filter((box) => box.t > mark)
  const before = path.filter((box) => box.t <= mark)
  expect(before.length).toBeGreaterThan(2)
  expect(after.length).toBeGreaterThan(4)
  // Continuous through the change: no jump back to where it started, or anywhere else.
  expect(jumps(path, 'mobile, then tablet mid-morph')).toEqual([])
  expect(after.some((box) => near(box, desktop.bounds, 20))).toBe(false)
  expect(near(path.at(-1) ?? null, tablet)).toBe(true)
  // The one snapshot from before the first change.
  expect((await session.app.evaluate(captureTimings)).length).toBe(captures + 1)
  await collectTimings(session)
})

test('the drawer slides with the preview it covers, and both land exactly', async ({ launch }) => {
  const session = tracked(await launch({ fixture: 'vite', env: MORPHING }))
  const { view: desktop } = await ready(session)

  // Opening: the snapshot is clipped from the bottom as the drawer rises with its edge.
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
  const rising = boxes(open.frames)
  expect(rising.length).toBeGreaterThan(5)
  expect(near(rising[0] ?? null, desktop.bounds)).toBe(true)
  expect(near(rising.at(-1) ?? null, shorter)).toBe(true)
  // Clipped, not scaled: the picture keeps its size while the box shrinks.
  for (const frame of open.frames) {
    for (const layer of frame.layers)
      expect(Math.abs(layer.width - desktop.bounds.width)).toBeLessThan(1)
  }
  const tracking = (frames: ChromeFrame[]) =>
    frames.flatMap((frame) =>
      frame.box && frame.drawer
        ? [Math.abs(frame.drawer.y - (frame.box.y + frame.box.height))]
        : [],
    )
  const gapsOpen = tracking(open.frames)
  expect(gapsOpen.length).toBeGreaterThan(5)
  expect(Math.max(...gapsOpen)).toBeLessThan(4)
  const drawerTops = [...new Set(open.frames.flatMap((f) => (f.drawer ? [f.drawer.y] : [])))]
  expect(drawerTops.length).toBeGreaterThan(5)

  // Closing: the drawer goes down and the preview's edge follows it.
  const close = await withEvidence(session, 'drawer-close', () =>
    record(
      session,
      () => session.chrome.evaluate(() => window.gui.setDrawerOpen(false)),
      'the preview filling the canvas again',
    ),
  )
  expect(close.end.expected).toEqual(desktop.bounds)
  const falling = boxes(close.frames)
  expect(falling.length).toBeGreaterThan(5)
  expect(near(falling[0] ?? null, shorter)).toBe(true)
  expect(near(falling.at(-1) ?? null, desktop.bounds)).toBe(true)
  const gapsClose = tracking(close.frames)
  expect(gapsClose.length).toBeGreaterThan(5)
  expect(Math.max(...gapsClose)).toBeLessThan(4)
  // The drawer is gone from the layout, with nothing left of its slide.
  const drawer = await session.chrome.evaluate(() => {
    const section = document.querySelector<HTMLElement>('section[aria-label="Terminal"]')
    return section ? { height: section.offsetHeight, transform: section.style.transform } : null
  })
  expect(drawer?.height).toBeLessThanOrEqual(1)
  expect(drawer?.transform).toBe('')
  await collectTimings(session)
})

test('zoom steps, focus mode and docking morph, and land on their exact layout', async ({
  launch,
}) => {
  const session = tracked(await launch({ fixture: 'vite', env: MORPHING }))
  const { view: desktop } = await ready(session)

  // Zoom in on Desktop: the frame stays, the picture inside scales up from its middle.
  const zoom = await withEvidence(session, 'zoom-in', () =>
    record(session, () => session.chrome.evaluate(() => window.gui.zoomPreview(1)), 'zoomed in'),
  )
  expect(zoom.end.expected).toEqual(desktop.bounds)
  const scaled = zoom.frames.flatMap((frame) => frame.layers.map((layer) => layer.width))
  expect(scaled.some((width) => width > desktop.bounds.width + 20)).toBe(true)
  expect((await session.state()).preview.zoom).toBe(1.1)
  await session.chrome.evaluate(() => window.gui.zoomPreview(0))
  await waitFor(async () => (await session.state()).preview.zoom === 1, 'back to 100%')
  await landed(session, 'at 100% again')

  // Focus mode: the preview grows up into the toolbar's room as the bars fade and slide away.
  const focus = await withEvidence(session, 'focus-enter', () =>
    record(session, () => session.chrome.evaluate(() => window.gui.setFocusMode(true)), 'focused'),
  )
  expect(focus.end.expected.y).toBe(FOCUS_BAR_HEIGHT)
  const growing = boxes(focus.frames)
  expect(growing.length).toBeGreaterThan(5)
  expect(near(growing[0] ?? null, desktop.bounds)).toBe(true)
  expect(near(growing.at(-1) ?? null, focus.end.expected)).toBe(true)
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
  expect(boxes(unfocus.frames).length).toBeGreaterThan(5)

  // Docking the chat: the preview gives up its right side, uncovered then cross-faded.
  const dock = await withEvidence(session, 'dock', () =>
    record(session, () => session.chat.evaluate(() => window.gui.toggleDock()), 'docked'),
  )
  expect(dock.end.expected.width).toBeLessThan(desktop.bounds.width - 200)
  const narrowing = boxes(dock.frames)
  expect(narrowing.length).toBeGreaterThan(5)
  expect(near(narrowing.at(-1) ?? null, dock.end.expected)).toBe(true)
  // The docked panel slid in from the canvas's right edge to cover it, rather than appearing.
  const docked = dock.samples.flatMap((sample) => (sample.chat ? [sample.chat.x] : []))
  const slid = docked.filter((x, i) => i === 0 || x !== docked[i - 1])
  const dockedX = dock.end.expected.x + dock.end.expected.width
  expect(
    slid.filter((x) => x > dockedX + 20 && x < desktop.bounds.width - 20).length,
  ).toBeGreaterThan(3)
  expect(slid.at(-1)).toBe(dockedX)
  const undock = await record(
    session,
    () => session.chat.evaluate(() => window.gui.toggleDock()),
    'floating again',
  )
  expect(undock.end.expected).toEqual(desktop.bounds)
  await collectTimings(session)
})

test('a click on the moving snapshot puts the live view in its new place at once', async ({
  launch,
}) => {
  const session = tracked(await launch({ fixture: 'vite', env: MORPHING }))
  const { view: desktop } = await ready(session)
  await setViewport(session, 'mobile')
  const box = await waitFor(
    () =>
      session.chrome.evaluate((width) => {
        const snapshot = document.querySelector('[data-morph-snapshot]')
        const rect = snapshot?.getBoundingClientRect()
        if (!rect || rect.width > width * 0.85) return null
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }, desktop.bounds.width),
    'the snapshot on its way',
    { timeout: 5_000, interval: 5 },
  )
  const clicked = Date.now()
  await session.chrome.mouse.click(box.x + box.width / 2, box.y + 40)
  const { expected } = await landed(session, 'the live view after the click', { timeout: 2_000 })
  const took = Date.now() - clicked
  // The spring had a good way to go; the click didn't wait for it.
  expect(took).toBeLessThan(250)
  expect(expected.width).toBeLessThan(box.width - 40)
  console.log(`[e2e] a click mid-morph showed the live view after ${took} ms`)
  await collectTimings(session)
})

test('with Reduce motion on, the preview changes in place and the snapshot only fades', async ({
  launch,
}) => {
  const session = tracked(await launch({ fixture: 'vite', env: MORPHING, reducedMotion: 'reduce' }))
  const { view: desktop } = await ready(session)

  const { frames, samples, end } = await withEvidence(session, 'reduced-mobile', () =>
    record(session, () => setViewport(session, 'mobile'), 'the mobile frame'),
  )
  // The live view went straight from one layout to the other: never out of sight, never between.
  const live = viewPath(samples, desktop.content.height)
  expect(live.map((step) => step.bounds)).toEqual([desktop.bounds, end.expected])
  // The snapshot never moved: it faded out where the desktop preview was.
  const path = boxes(frames)
  expect(path.length).toBeLessThanOrEqual(1)
  for (const frame of frames) if (frame.box) expect(near(frame.box, desktop.bounds)).toBe(true)
  const opacities = frames.flatMap((frame) => frame.layers.map((layer) => layer.opacity))
  expect(opacities.some((opacity) => opacity > 0.05 && opacity < 0.95)).toBe(true)

  // The drawer fades in place rather than sliding.
  const drawer = await record(
    session,
    () => session.chrome.evaluate(() => window.gui.setDrawerOpen(true)),
    'the drawer open',
  )
  const tops = new Set(drawer.frames.flatMap((frame) => (frame.drawer ? [frame.drawer.y] : [])))
  expect(tops.size).toBe(1)
  await collectTimings(session)
})

test('a snapshot slower than its budget makes the change instant, the view straight to its place', async ({
  launch,
}) => {
  // No time at all to capture: every change falls back.
  const session = tracked(
    await launch({ fixture: 'vite', env: { GUI_E2E_CAPTURE_BUDGET_MS: '0' } }),
  )
  const { view: desktop } = await ready(session)
  const captures = (await session.app.evaluate(captureTimings)).length
  const fellBack = (await session.app.evaluate(captureFallbacks)).length

  const { frames, samples, end } = await record(
    session,
    () => setViewport(session, 'mobile'),
    'the mobile frame, at once',
  )
  const mobile = end.expected
  expect(mobile.width).toBeLessThan(desktop.bounds.width / 2)

  // Nothing drawn in the chrome, and the live view went from where it was to where it goes,
  // never out of sight.
  expect(boxes(frames)).toEqual([])
  const events = await session.chrome.evaluate(
    () => (globalThis as unknown as ChromeStore).guiMorphs ?? [],
  )
  expect(events.map((event) => event.type)).toEqual(['pending', 'end'])
  const live = viewPath(samples, desktop.content.height)
  expect(live.map((step) => step.bounds)).toEqual([desktop.bounds, mobile])
  expect(live.every((step) => step.visible && !step.outOfSight)).toBe(true)
  // Said why, once its late capture came back; and not kept as a snapshot.
  await waitFor(
    async () => (await session.app.evaluate(captureFallbacks)).length > fellBack || null,
    'the fallback noted',
  )
  expect((await session.app.evaluate(captureFallbacks)).at(-1)?.reason).toBe('slow')
  expect((await session.app.evaluate(captureTimings)).length).toBe(captures)
  const preview = await session.previewPage()
  expect(await preview.evaluate(() => innerWidth)).toBe(390)
})
