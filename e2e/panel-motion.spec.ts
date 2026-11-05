import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rect } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Letting go of the floating chat panel springs it into a corner of the canvas: the one a
// throw heads for, or the nearest after a slow drop. Main moves the native view on a spring
// (src/main/panel-flight.ts), so these read the view's bounds from main as it moves.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** Transparent margin around the floating panel's view (PANEL_SHADOW_MARGIN). */
const SHADOW = 18
/** Space the panel keeps from the canvas's edges in its corner (PANEL_MARGIN). */
const MARGIN = 12
/** Short enough for CI's screen; the panel is made shorter still so corners differ. */
const WINDOW = { width: 1100, height: 680 }
/** These start from the bottom-left corner (new windows default to the bottom-right). */
const BOTTOM_LEFT_PREFS = { chatCorner: { x: 'left', y: 'bottom' } }

interface Layout {
  chat: Rect
  preview: Rect
}

/** Runs in main: the chat and preview views' bounds, read in a task of their own. */
async function chatLayout({ BrowserWindow, WebContentsView }: ElectronModule) {
  await new Promise<void>((resolve) => setImmediate(() => resolve()))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const views = win.contentView.children.filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const chat = views.find((view) => view.webContents.getURL().endsWith('/chat.html'))
  const preview = views.find((view) => /^https?:\/\//.test(view.webContents.getURL()))
  if (!chat?.getVisible() || !preview) return null
  return { chat: chat.getBounds(), preview: preview.getBounds() }
}

function layoutWhen(session: GuiSession, label: string, check: (layout: Layout) => boolean) {
  return waitFor(async () => {
    const layout = await session.app.evaluate(chatLayout)
    return layout && check(layout) ? layout : null
  }, label)
}

/** How far the visible panel is from each edge of the canvas, which the preview fills. */
function gaps({ chat, preview }: Layout) {
  return {
    left: chat.x + SHADOW - preview.x,
    top: chat.y + SHADOW - preview.y,
    right: preview.x + preview.width - (chat.x + chat.width - SHADOW),
    bottom: preview.y + preview.height - (chat.y + chat.height - SHADOW),
  }
}

interface Store {
  guiChatSamples?: { t: number; x: number; y: number }[]
  guiChatSampler?: NodeJS.Timeout
}

/** Runs in main: records the chat view's position every 4 ms until `stopSampling`. */
function startSampling({ BrowserWindow, WebContentsView }: ElectronModule) {
  const store = globalThis as unknown as Store
  const win = BrowserWindow.getAllWindows()[0]
  const chat = win?.contentView.children.find(
    (child): child is InstanceType<typeof WebContentsView> =>
      child instanceof WebContentsView && child.webContents.getURL().endsWith('/chat.html'),
  )
  if (!chat) throw new Error('No chat view')
  const samples: { t: number; x: number; y: number }[] = []
  const start = performance.now()
  store.guiChatSamples = samples
  store.guiChatSampler = setInterval(() => {
    const { x, y } = chat.getBounds()
    samples.push({ t: Math.round(performance.now() - start), x, y })
  }, 4)
}

function stopSampling() {
  const store = globalThis as unknown as Store
  if (store.guiChatSampler) clearInterval(store.guiChatSampler)
  return store.guiChatSamples ?? []
}

/** The positions the view passed through, each once, in order. */
function path(samples: { x: number; y: number }[]) {
  return samples.filter((s, i) => i === 0 || s.x !== samples[i - 1]?.x || s.y !== samples[i - 1]?.y)
}

/** Runs in main: sets the window's content size. */
function setContentSize(
  { BrowserWindow }: ElectronModule,
  size: { width: number; height: number },
) {
  BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
}

/** The app at WINDOW's size, its panel 200 px shorter than usual, resting bottom-left. */
async function ready(session: GuiSession) {
  await session.waitForPreview()
  await session.expandChat()
  await session.app.evaluate(setContentSize, WINDOW)
  const sized = await layoutWhen(
    session,
    'the window at its test size',
    ({ preview }) => preview.width === WINDOW.width,
  )
  await session.chat.evaluate(() => {
    window.gui.resizeChat('top', 0, 200)
    window.gui.endResizeChat()
  })
  return layoutWhen(
    session,
    'the shorter panel',
    ({ chat }) =>
      chat.height < sized.chat.height && gaps({ chat, preview: sized.preview }).bottom === MARGIN,
  )
}

/** Drags by (dx, dy), lets go at `velocity`, and records the view's path until it rests. */
async function throwPanel(
  session: GuiSession,
  drag: { dx: number; dy: number },
  velocity: { x: number; y: number },
  rested: (layout: Layout) => boolean,
) {
  const before = await layoutWhen(session, 'the panel', () => true)
  await session.chat.evaluate(({ dx, dy }) => window.gui.dragChat(dx, dy), drag)
  await layoutWhen(
    session,
    'the drag',
    ({ chat }) => chat.x === before.chat.x + drag.dx && chat.y === before.chat.y + drag.dy,
  )
  await session.app.evaluate(startSampling)
  await session.chat.evaluate((v) => window.gui.endDragChat(v), velocity)
  const end = await layoutWhen(session, 'the panel at rest in its corner', rested)
  // A little longer: nothing may move once it has landed.
  await sleep(300)
  const samples = await session.app.evaluate(stopSampling)
  return { end, samples }
}

test('a fast release throws the panel into the corner it heads for', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  const start = await ready(session)
  expect(gaps(start)).toMatchObject({ left: MARGIN, bottom: MARGIN })

  // A short drag up and right, let go fast toward the top-right: it carries on there.
  const { end, samples } = await throwPanel(
    session,
    { dx: 60, dy: -40 },
    { x: 2400, y: -1800 },
    (layout) => gaps(layout).top === MARGIN && gaps(layout).right === MARGIN,
  )
  await testInfo.attach('throw-path.json', {
    body: JSON.stringify(samples),
    contentType: 'application/json',
  })
  const moves = path(samples)
  // It flew there over many frames, rather than jumping.
  expect(moves.length).toBeGreaterThan(8)
  const last = moves.at(-1)
  expect(last).toMatchObject({ x: end.chat.x, y: end.chat.y })
  // Thrown, it may overshoot its corner a little, but no further than the window allows.
  const furthest = Math.max(...moves.map((s) => s.x))
  expect(furthest - end.chat.x).toBeLessThanOrEqual(MARGIN)
  // Settled for good: the last 300 ms didn't move it.
  const tail = samples.filter((s) => s.t > (samples.at(-1)?.t ?? 0) - 250)
  expect(new Set(tail.map((s) => `${s.x},${s.y}`)).size).toBe(1)
  expect(end.chat.width).toBe(start.chat.width)
  expect(end.chat.height).toBe(start.chat.height)
})

test('a slow drop settles in the nearest corner without overshooting', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  const start = await ready(session)

  // Dragged until its middle is just right of the canvas's, low down, and let go at rest.
  const panelCenter = start.chat.x + start.chat.width / 2
  const canvasCenter = start.preview.x + start.preview.width / 2
  const dx = Math.round(canvasCenter - panelCenter + 80)
  const { end, samples } = await throwPanel(
    session,
    { dx, dy: -30 },
    { x: 0, y: 0 },
    (layout) => gaps(layout).bottom === MARGIN && gaps(layout).right === MARGIN,
  )
  const moves = path(samples)
  expect(moves.length).toBeGreaterThan(4)
  // Critically damped: it never passes its corner.
  expect(Math.max(...moves.map((s) => s.x))).toBeLessThanOrEqual(end.chat.x)
  expect(Math.max(...moves.map((s) => s.y))).toBeLessThanOrEqual(end.chat.y)

  // A gentle push back toward the left is too slow to carry it across the middle.
  const slow = await throwPanel(
    session,
    { dx: -20, dy: 0 },
    { x: -200, y: 0 },
    (layout) => gaps(layout).right === MARGIN && gaps(layout).bottom === MARGIN,
  )
  expect(slow.end.chat).toEqual(end.chat)
})

test('grabbing the panel mid-flight catches it where it is', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  const start = await ready(session)

  await session.chat.evaluate(() => window.gui.endDragChat({ x: 3000, y: -2500 }))
  // In flight: off its start, not yet in its corner.
  const moving = await waitFor(
    async () => {
      const layout = await session.app.evaluate(chatLayout)
      if (!layout) return null
      const { top, right } = gaps(layout)
      const away = layout.chat.x !== start.chat.x || layout.chat.y !== start.chat.y
      return away && (top !== MARGIN || right !== MARGIN) ? layout : null
    },
    'the panel in flight',
    { interval: 10 },
  )
  // The pointer presses the header 120 px in, where the view is at that moment.
  const content = await session.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getContentBounds(),
  )
  if (!content) throw new Error('No window')
  const at = { x: 120 + SHADOW, y: 20 + SHADOW }
  const grab = {
    screenX: content.x + moving.chat.x + at.x,
    screenY: content.y + moving.chat.y + at.y,
    clientX: at.x,
    clientY: at.y,
  }
  await session.chat.evaluate((g) => window.gui.grabChat(g), grab)
  const caught = await layoutWhen(
    session,
    'the panel caught where it was pressed',
    ({ chat }) => chat.x === moving.chat.x && chat.y === moving.chat.y,
  )
  await sleep(400)
  expect((await session.app.evaluate(chatLayout))?.chat).toEqual(caught.chat)

  // The first sampled flight frame can still be near an edge. Drag toward the canvas's
  // center so window-edge clamping does not mask the exact pointer delta being tested.
  const drag = {
    dx:
      caught.chat.x + caught.chat.width / 2 < caught.preview.x + caught.preview.width / 2
        ? 30
        : -30,
    dy:
      caught.chat.y + caught.chat.height / 2 < caught.preview.y + caught.preview.height / 2
        ? 25
        : -25,
  }
  await session.chat.evaluate(({ dx, dy }) => window.gui.dragChat(dx, dy), drag)
  const dragged = await layoutWhen(
    session,
    'the caught panel dragged',
    ({ chat }) => chat.x !== caught.chat.x || chat.y !== caught.chat.y,
  )
  expect(dragged.chat).toEqual({
    ...caught.chat,
    x: caught.chat.x + drag.dx,
    y: caught.chat.y + drag.dy,
  })
  await session.chat.evaluate(() => window.gui.endDragChat({ x: 0, y: 0 }))
  await layoutWhen(session, 'the panel in a corner again', (layout) => {
    const { left, right, top, bottom } = gaps(layout)
    return (left === MARGIN || right === MARGIN) && (top === MARGIN || bottom === MARGIN)
  })
})

test('with Reduce motion on, the panel jumps to its corner', async ({ launch }) => {
  const session = await launch({
    fixture: 'vite',
    reducedMotion: 'reduce',
    prefs: BOTTOM_LEFT_PREFS,
  })
  await ready(session)
  const { end, samples } = await throwPanel(
    session,
    { dx: 40, dy: -40 },
    { x: 2400, y: -1800 },
    (layout) => gaps(layout).top === MARGIN && gaps(layout).right === MARGIN,
  )
  // From where it was dropped straight to its corner: no positions in between.
  const moves = path(samples)
  expect(moves.length).toBeLessThanOrEqual(2)
  expect(moves.at(-1)).toMatchObject({ x: end.chat.x, y: end.chat.y })
})

// The panel and its bubble (or pill) are one thing changing shape: the panel shrinks toward
// its anchored corner as the bubble grows out of it, inside a view main keeps at the panel's
// size until the chat says the morph is done. These record every frame in the chat page.

/** One frame in the chat page: the view's size, and each form's scale and opacity. */
interface MorphFrame {
  t: number
  width: number
  panel?: { scale: number; opacity: number }
  pill?: { scale: number; opacity: number }
  bubble?: { scale: number; opacity: number }
}

interface MorphStore {
  guiMorphFrames?: MorphFrame[]
  guiMorphRecording?: boolean
}

/** Runs in the chat page: records a MorphFrame every animation frame until `stopRecording`. */
function startRecording() {
  const store = globalThis as unknown as MorphStore
  const frames: MorphFrame[] = []
  const start = performance.now()
  store.guiMorphFrames = frames
  store.guiMorphRecording = true
  const record = () => {
    const frame: MorphFrame = { t: Math.round(performance.now() - start), width: innerWidth }
    for (const el of document.querySelectorAll<HTMLElement>('[data-chat-form]')) {
      const style = getComputedStyle(el)
      const scale = style.transform === 'none' ? 1 : Number(style.transform.slice(7).split(',')[0])
      const form = el.dataset.chatForm as 'panel' | 'pill' | 'bubble'
      frame[form] = { scale, opacity: Number(style.opacity) }
    }
    frames.push(frame)
    if (store.guiMorphRecording) requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
}

function stopRecording() {
  const store = globalThis as unknown as MorphStore
  store.guiMorphRecording = false
  return store.guiMorphFrames ?? []
}

/** The bubble's view width: the 44 px bubble and its shadow margin. */
const BUBBLE_VIEW = 44 + SHADOW * 2

async function setSelecting(session: GuiSession, on: boolean) {
  await session.chrome.evaluate((on) => {
    if (on) window.gui.toggleSelect()
    else window.gui.stopSelecting()
  }, on)
  const label = on ? 'design mode' : 'design mode to end'
  await waitFor(async () => (await session.state()).preview.selecting === on, label)
}

test('picking morphs the panel into its bubble and back along the same path', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  const start = await ready(session)
  const panelWidth = start.chat.width

  // Into the bubble: the panel shrinks toward its bottom-left corner while the view keeps its
  // size, and only then does the view shrink to the bubble.
  await session.chat.evaluate(startRecording)
  await setSelecting(session, true)
  await layoutWhen(session, 'the bubble', ({ chat }) => chat.width === BUBBLE_VIEW)
  await sleep(600)
  const into = await session.chat.evaluate(stopRecording)
  await testInfo.attach('morph-into-bubble.json', {
    body: JSON.stringify(into),
    contentType: 'application/json',
  })
  const shrinking = into.filter(
    (f) => f.width === panelWidth && f.panel && f.panel.scale < 0.95 && f.panel.scale > 0.15,
  )
  expect(shrinking.length).toBeGreaterThan(3)
  // The panel went smaller and fainter frame by frame, never back.
  for (let i = 1; i < shrinking.length; i++) {
    expect(shrinking[i]?.panel?.scale).toBeLessThanOrEqual(shrinking[i - 1]?.panel?.scale ?? 1)
  }
  // The view shrank once the panel was gone, on the chat's word rather than main's fallback.
  const firstSmall = into.findIndex((f) => f.width === BUBBLE_VIEW)
  expect(firstSmall).toBeGreaterThan(0)
  expect(into[firstSmall]?.panel?.opacity ?? 0).toBeLessThan(0.05)
  const morphStart = into.find((f) => f.panel && f.panel.scale < 1)?.t ?? 0
  expect((into[firstSmall]?.t ?? 0) - morphStart).toBeLessThan(650)
  expect(into.at(-1)?.bubble).toEqual({ scale: 1, opacity: 1 })

  // Back: the view grows first, then the panel grows out of the bubble's corner.
  await session.chat.evaluate(startRecording)
  await setSelecting(session, false)
  const back = await layoutWhen(session, 'the panel again', ({ chat }) => chat.width === panelWidth)
  expect(back.chat).toEqual(start.chat)
  await sleep(600)
  const out = await session.chat.evaluate(stopRecording)
  await testInfo.attach('morph-out-of-bubble.json', {
    body: JSON.stringify(out),
    contentType: 'application/json',
  })
  const growing = out.filter((f) => f.panel && f.panel.scale < 0.95)
  expect(growing.length).toBeGreaterThan(3)
  expect(growing[0]?.width).toBe(panelWidth)
  expect(growing[0]?.panel?.scale ?? 1).toBeLessThan(0.4)
  expect(out.at(-1)?.panel).toEqual({ scale: 1, opacity: 1 })
  expect(out.at(-1)?.bubble).toBeUndefined()

  // Interrupted halfway, it turns around from where it is: no jump in scale.
  await session.chat.evaluate(startRecording)
  await setSelecting(session, true)
  await sleep(150)
  await setSelecting(session, false)
  await sleep(700)
  const turned = await session.chat.evaluate(stopRecording)
  await testInfo.attach('morph-interrupted.json', {
    body: JSON.stringify(turned),
    contentType: 'application/json',
  })
  const scales = turned.flatMap((f) => (f.panel ? [f.panel.scale] : []))
  expect(Math.min(...scales)).toBeLessThan(0.9)
  for (let i = 1; i < scales.length; i++) {
    expect(Math.abs((scales[i] ?? 0) - (scales[i - 1] ?? 0))).toBeLessThan(0.2)
  }
  expect(turned.at(-1)?.panel).toEqual({ scale: 1, opacity: 1 })
  expect((await session.app.evaluate(chatLayout))?.chat).toEqual(start.chat)
})

test('minimizing morphs the panel into its pill and back', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  const start = await ready(session)
  await session.chat.evaluate(startRecording)
  await session.chat.evaluate(() => window.gui.setMinimized(true))
  const pill = await layoutWhen(session, 'the pill', ({ chat }) => chat.height === 52 + SHADOW * 2)
  const into = await session.chat.evaluate(stopRecording)
  // In the panel's view while it shrank, then the pill's, in the same bottom-left corner.
  expect(into.some((f) => f.width === start.chat.width && f.panel && f.panel.scale < 0.95)).toBe(
    true,
  )
  expect(pill.chat.x).toBe(start.chat.x)
  expect(pill.chat.y + pill.chat.height).toBe(start.chat.y + start.chat.height)
  await expect(session.chat.getByRole('button', { name: 'Expand chat' })).toBeVisible()

  await session.chat.getByRole('button', { name: 'Expand chat' }).click()
  const back = await layoutWhen(
    session,
    'the panel again',
    ({ chat }) => chat.height > pill.chat.height,
  )
  expect(back.chat).toEqual(start.chat)
  await expect(session.chat.getByRole('button', { name: 'Minimize' })).toBeVisible()
})

test('with reduced motion the bubble cross-fades in place', async ({ launch }) => {
  const session = await launch({
    fixture: 'vite',
    reducedMotion: 'reduce',
    prefs: BOTTOM_LEFT_PREFS,
  })
  const start = await ready(session)
  await session.chat.evaluate(startRecording)
  await setSelecting(session, true)
  await layoutWhen(session, 'the bubble', ({ chat }) => chat.width === BUBBLE_VIEW)
  const frames = await session.chat.evaluate(stopRecording)
  // Nothing scales: the panel fades out and the bubble fades in where they are.
  for (const frame of frames) {
    expect(frame.panel?.scale ?? 1).toBe(1)
    expect(frame.bubble?.scale ?? 1).toBe(1)
  }
  expect(frames.some((f) => f.panel && f.panel.opacity > 0 && f.panel.opacity < 1)).toBe(true)
  await setSelecting(session, false)
  const back = await layoutWhen(
    session,
    'the panel again',
    ({ chat }) => chat.width === start.chat.width,
  )
  expect(back.chat).toEqual(start.chat)
})

// Dragged to the window's left or right edge, the floating chat docks there; the sidebar,
// pulled by its header, comes off as the floating panel under the pointer. These drive main's
// side of the drag (`grabChat` with the pointer's screen position, then its moves) as the chat
// page sends it, since the native view moves under a real pointer.

/** The sidebar's width (chatSidebarWidth's default). */
const DOCK_WIDTH = 380

/** Runs in main: the window's content bounds, which screen positions are offset by. */
function contentBounds({ BrowserWindow }: ElectronModule) {
  const bounds = BrowserWindow.getAllWindows()[0]?.getContentBounds()
  if (!bounds) throw new Error('No window')
  return bounds
}

/**
 * Runs in main: the dock target (a view of Gui's own) if it's showing, where, whether it's
 * just under the chat, and whether its page has faded it in.
 */
async function dockTargetShown({ BrowserWindow, WebContentsView }: ElectronModule) {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const views = win.contentView.children
  const target = views.find(
    (view): view is InstanceType<typeof WebContentsView> =>
      view instanceof WebContentsView && view.webContents.getURL().startsWith('data:text/html'),
  )
  if (!target?.getVisible() || !views.includes(target)) return null
  const chat = views.findIndex(
    (view) => view instanceof WebContentsView && view.webContents.getURL().endsWith('/chat.html'),
  )
  const shown = await target.webContents.executeJavaScript(
    "document.body.classList.contains('shown')",
  )
  return { bounds: target.getBounds(), under: views.indexOf(target) === chat - 1, shown }
}

interface MorphSample {
  chat: Rect
  preview: Rect
}

interface MorphStore {
  guiMorphSamples?: MorphSample[]
  guiMorphSampler?: NodeJS.Timeout
}

/** Runs in main: records the chat's and the preview's bounds every 4 ms until stopped. */
function startMorphSampling({ BrowserWindow, WebContentsView }: ElectronModule) {
  const store = globalThis as unknown as MorphStore
  const views = (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const chat = views.find((view) => view.webContents.getURL().endsWith('/chat.html'))
  const preview = views.find((view) => /^https?:\/\//.test(view.webContents.getURL()))
  if (!chat || !preview) throw new Error('No chat or preview view')
  const samples: MorphSample[] = []
  store.guiMorphSamples = samples
  store.guiMorphSampler = setInterval(() => {
    samples.push({ chat: chat.getBounds(), preview: preview.getBounds() })
  }, 4)
}

function stopMorphSampling() {
  const store = globalThis as unknown as MorphStore
  if (store.guiMorphSampler) clearInterval(store.guiMorphSampler)
  return store.guiMorphSamples ?? []
}

const RECT_KEYS = ['x', 'y', 'width', 'height'] as const

function sameRect(a: Rect, b: Rect) {
  return RECT_KEYS.every((key) => a[key] === b[key])
}

/** The rects a view passed through, each once, in order. */
function rects(samples: Rect[]) {
  return samples.filter((rect, i) => i === 0 || !sameRect(rect, samples[i - 1] as Rect))
}

/** A rect's edges, in the window. */
function edgesOf({ x, y, width, height }: Rect) {
  return { left: x, top: y, right: x + width, bottom: y + height }
}

/**
 * The view moved from `from` to `to` smoothly: over several frames, each edge one way only
 * (never back, so no edge jitters), and no frame a jump (more than 40% of the way, or 2 px).
 */
function expectSmooth(label: string, samples: Rect[], from: Rect, to: Rect) {
  const path = rects(samples)
  expect(path[0], `${label} starts where it was`).toEqual(from)
  expect(path.at(-1), `${label} ends where it rests`).toEqual(to)
  expect(path.length, `${label} moves over several frames`).toBeGreaterThan(5)
  const start = edgesOf(from)
  const end = edgesOf(to)
  for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    const total = end[edge] - start[edge]
    for (let i = 1; i < path.length; i++) {
      const step = edgesOf(path[i] as Rect)[edge] - edgesOf(path[i - 1] as Rect)[edge]
      expect(
        step * Math.sign(total),
        `${label}: ${edge} edge turns back at frame ${i}`,
      ).toBeGreaterThanOrEqual(0)
      expect(Math.abs(step), `${label}: ${edge} edge jumps at frame ${i}`).toBeLessThanOrEqual(
        Math.max(2, Math.abs(total) * 0.4),
      )
    }
  }
}

/** How far along from `from` to `to` `value` is, 0 to 1. */
function along(value: number, from: number, to: number) {
  return from === to ? 1 : (value - from) / (to - from)
}

/**
 * The chat's shape and the preview's edge beside it (`edges`) get there together, frame for
 * frame: never more than 5% of the way apart.
 */
function expectTogether(
  label: string,
  samples: MorphSample[],
  edges: (sample: MorphSample) => { chat: number; preview: number },
) {
  const first = edges(samples[0] as MorphSample)
  const last = edges(samples.at(-1) as MorphSample)
  for (const sample of samples) {
    const now = edges(sample)
    const chat = along(now.chat, first.chat, last.chat)
    const preview = along(now.preview, first.preview, last.preview)
    expect(
      Math.abs(chat - preview),
      `${label}: the chat and the preview apart`,
    ).toBeLessThanOrEqual(0.05)
  }
}

/** Runs in main: main's springs run `scale` times slower (unpackaged builds). */
function slowMotion(_: ElectronModule, scale: number) {
  ;(globalThis as { guiMotionScale?: number }).guiMotionScale = scale
}

/** Runs in main: no preview morph in flight. */
function morphing() {
  return ((globalThis as { guiMorphing?: Set<number> }).guiMorphing?.size ?? 0) > 0
}

/** Presses the chat's header at `at`, in the window's content, as the chat page reports it. */
async function press(session: GuiSession, at: { x: number; y: number }) {
  const content = await session.app.evaluate(contentBounds)
  await session.chat.evaluate((grab) => window.gui.grabChat(grab), {
    screenX: content.x + at.x,
    screenY: content.y + at.y,
    clientX: 0,
    clientY: 0,
  })
}

function move(session: GuiSession, dx: number, dy: number) {
  return session.chat.evaluate(({ dx, dy }) => window.gui.dragChat(dx, dy), { dx, dy })
}

function release(session: GuiSession) {
  return session.chat.evaluate(() => window.gui.endDragChat({ x: 0, y: 0 }))
}

/** ⇧⌘D, from its menu item (Playwright's keys don't reach the menu). */
function toggleDockShortcut(session: GuiSession) {
  return session.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.accelerator === 'Shift+CmdOrCtrl+D') return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item) throw new Error('No ⇧⌘D menu item')
    item.click()
  })
}

/** The chat docked on `side`, at rest: the window's full height at that edge. */
function dockedOn(session: GuiSession, side: 'left' | 'right') {
  return waitFor(async () => {
    const state = await session.state()
    if (state.sidebarSide !== side || state.sidebarWidth !== DOCK_WIDTH) return null
    if (await session.app.evaluate(morphing)) return null
    const layout = await session.app.evaluate(chatLayout)
    if (!layout) return null
    const x = side === 'left' ? 0 : WINDOW.width - DOCK_WIDTH
    const { chat, preview } = layout
    return chat.x === x &&
      chat.y === 0 &&
      chat.height === WINDOW.height &&
      preview.width < WINDOW.width
      ? layout
      : null
  }, `the chat docked on the ${side}`)
}

test('dragged to an edge the chat docks there, and pulled off the sidebar it floats', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  const start = await ready(session)
  const panel = { width: start.chat.width - SHADOW * 2, height: start.chat.height - SHADOW * 2 }

  // Held by its header, the panel follows the pointer; near the right edge, the sidebar's
  // place shows there, under the chat. Nothing docks until it's let go.
  const header = { x: start.chat.x + SHADOW + 100, y: start.chat.y + SHADOW + 18 }
  await press(session, header)
  const toEdge = { dx: WINDOW.width - 20 - header.x, dy: -120 }
  await move(session, toEdge.dx, toEdge.dy)
  const target = await waitFor(async () => {
    const shown = await session.app.evaluate(dockTargetShown)
    return shown?.shown ? shown : null
  }, 'the dock target on the right')
  expect(target.bounds).toEqual({
    x: WINDOW.width - DOCK_WIDTH,
    y: 0,
    width: DOCK_WIDTH,
    height: WINDOW.height,
  })
  expect(target.under).toBe(true)
  expect((await session.state()).sidebarWidth).toBe(0)
  await session.shot('dock-target-right')

  // Back out of reach, it goes; back in, it's back.
  await move(session, -200, 0)
  await waitFor(async () => (await session.app.evaluate(dockTargetShown)) === null, 'no target')
  await move(session, 200, 0)
  await waitFor(async () => (await session.app.evaluate(dockTargetShown))?.shown, 'the target')

  // Let go there: docked on the right, the preview narrowed beside it, and the choice saved.
  // The card turns into the sidebar in one shape, from where it was let go, as the preview
  // narrows on the same spring: nothing jumps or turns back, and their edges arrive together.
  const dropped = await layoutWhen(session, 'the panel at the edge', () => true)
  await session.app.evaluate(startMorphSampling)
  await release(session)
  const docked = await dockedOn(session, 'right')
  const docking = await session.app.evaluate(stopMorphSampling)
  expectSmooth(
    'the chat docking',
    docking.map(({ chat }) => chat),
    dropped.chat,
    docked.chat,
  )
  expectSmooth(
    'the preview narrowing',
    docking.map(({ preview }) => preview),
    dropped.preview,
    docked.preview,
  )
  expectTogether('docking', docking, ({ chat, preview }) => ({
    chat: chat.height,
    preview: preview.x + preview.width,
  }))
  // The target it filled goes once the sidebar covers it.
  await waitFor(async () => (await session.app.evaluate(dockTargetShown)) === null, 'no target')
  const profile = await session.app.evaluate(({ app }) => app.getPath('userData'))
  const prefs = () => JSON.parse(readFileSync(join(profile, 'prefs.json'), 'utf8'))
  expect(prefs()).toMatchObject({ chatSidebar: true, chatSidebarSide: 'right' })

  // Pressed on the sidebar's header and pulled less than a click's slop: still docked.
  const grabbed = { x: WINDOW.width - DOCK_WIDTH + 150, y: 20 }
  await press(session, grabbed)
  await move(session, -4, 3)
  expect((await session.state()).sidebarWidth).toBe(DOCK_WIDTH)

  // Pulled further, it comes off: the sidebar turns into the floating panel, which ends with
  // the same point of its header under the pointer (150 px across the 380 px sidebar is as far
  // across the panel), as the preview widens back under it on the same spring.
  await session.app.evaluate(startMorphSampling)
  await move(session, -296, 157)
  const pointer = { x: grabbed.x - 300, y: grabbed.y + 160 }
  const expected = {
    x: pointer.x - Math.round((150 / DOCK_WIDTH) * panel.width) - SHADOW,
    y: pointer.y - Math.round((20 / 44) * 36) - SHADOW,
  }
  const pulled = await waitFor(async () => {
    const state = await session.state()
    const layout = await session.app.evaluate(chatLayout)
    return state.sidebarWidth === 0 &&
      !(await session.app.evaluate(morphing)) &&
      layout?.preview.width === WINDOW.width &&
      layout.chat.x === expected.x &&
      layout.chat.y === expected.y
      ? layout
      : null
  }, 'the panel under the pointer, the preview widened back')
  const pulling = await session.app.evaluate(stopMorphSampling)
  expect(pulled.chat.width).toBe(start.chat.width)
  expectSmooth(
    'the chat pulled off',
    pulling.map(({ chat }) => chat),
    docked.chat,
    pulled.chat,
  )
  expectSmooth(
    'the preview widening',
    pulling.map(({ preview }) => preview),
    docked.preview,
    pulled.preview,
  )
  expectTogether('pulling off', pulling, ({ chat, preview }) => ({
    chat: chat.height,
    preview: preview.x + preview.width,
  }))
  // At rest under the pointer, it stays there while the pointer does.
  await session.app.evaluate(startSampling)
  await sleep(200)
  const held = path(await session.app.evaluate(stopSampling))
  expect(held).toEqual([{ t: expect.any(Number), x: expected.x, y: expected.y }])
  expect(prefs().chatSidebar).toBe(false)

  // Across to the left edge and let go: docked on the left.
  await move(session, 16 - pointer.x, 0)
  await waitFor(async () => {
    const shown = await session.app.evaluate(dockTargetShown)
    return shown?.shown && shown.bounds.x === 0 ? shown : null
  }, 'the dock target on the left')
  await session.shot('dock-target-left')
  await release(session)
  await dockedOn(session, 'left')
  expect(prefs()).toMatchObject({ chatSidebar: true, chatSidebarSide: 'left' })

  // A click on the sidebar's header is only a click; its buttons still work.
  const spot = await session.chat.evaluate(() => {
    const bar = document.querySelector('[data-chat-panel] header')
    const name = bar?.querySelector('button')?.getBoundingClientRect()
    const box = bar?.getBoundingClientRect()
    if (!name || !box) throw new Error('No sidebar header')
    const at = { x: Math.round(name.right + 12), y: Math.round(box.top + box.height / 2) }
    if (document.elementFromPoint(at.x, at.y)?.closest('button')) throw new Error('On a button')
    return at
  })
  await session.chat.mouse.click(spot.x, spot.y)
  expect((await session.state()).sidebarWidth).toBe(DOCK_WIDTH)
  await session.chat.getByRole('button', { name: 'Show as floating panel' }).click()
  await waitFor(async () => (await session.state()).sidebarWidth === 0, 'the chat floating')

  // ⇧⌘D docks it again on the side it was last, and floats it.
  await toggleDockShortcut(session)
  await dockedOn(session, 'left')
  await toggleDockShortcut(session)
  await waitFor(async () => (await session.state()).sidebarWidth === 0, 'the chat floating')

  if (process.env.GUI_E2E_SHOTS === '1') await shootDockMorphs(session)
})

/**
 * With GUI_E2E_SHOTS=1: shots of the chat about 30% and 60% of the way into the sidebar, and
 * back out of it, with main's springs slowed tenfold so the layers are caught together.
 */
async function shootDockMorphs(session: GuiSession) {
  const rest = await waitFor(async () => {
    const layout = await session.app.evaluate(chatLayout)
    return layout && !(await session.app.evaluate(morphing)) ? layout : null
  }, 'the panel at rest')
  const height = (layout: Layout | null) => layout?.chat.height ?? 0
  const shootAt = async (name: string, from: number, to: number) => {
    for (const share of [0.3, 0.6]) {
      await waitFor(
        async () => {
          const now = height(await session.app.evaluate(chatLayout))
          return along(now, from, to) >= share
        },
        `${name} ${share * 100}% of the way`,
      )
      await session.shot(`${name}-${share * 100}`)
    }
  }
  await press(session, { x: rest.chat.x + SHADOW + 100, y: rest.chat.y + SHADOW + 18 })
  await move(session, 20 - (rest.chat.x + SHADOW + 100), 0)
  await waitFor(async () => (await session.app.evaluate(dockTargetShown))?.shown, 'the target')
  await session.app.evaluate(slowMotion, 10)
  try {
    await release(session)
    await shootAt('dock-morph', rest.chat.height, WINDOW.height)
    await session.app.evaluate(slowMotion, 1)
    await dockedOn(session, 'left')
    await press(session, { x: 150, y: 20 })
    await session.app.evaluate(slowMotion, 10)
    await move(session, 120, 160)
    await shootAt('pull-off-morph', WINDOW.height, rest.chat.height)
  } finally {
    await session.app.evaluate(slowMotion, 1)
  }
  await release(session)
}
