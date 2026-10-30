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
  const label = on ? 'selection mode' : 'selection mode to end'
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
