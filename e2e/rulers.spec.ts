import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Point, Rect, RulerGuide } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Rulers and guides over the preview (main/guides.ts, app/rulers.tsx): ⇧R shows them, a guide
// is dragged out of a ruler, kept in page pixels (per project, in prefs), moves with the page's
// content, snaps to the element under the pointer, and goes back onto its ruler to go away.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** A guide's strip is this thick (main/guides.ts), its line the middle pixel. */
const STRIP = 7
const LINE = 3

type InputEvent =
  | { type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number; held?: boolean }
  | { type: 'keyDown' | 'char' | 'keyUp'; keyCode: string; shift?: boolean }

interface Layout {
  preview: Rect | null
  strips: { axis: RulerGuide['axis']; bounds: Rect }[]
}

/** Runs in main: where the preview is, and the guides' strips shown over it. */
function layout({ BrowserWindow, WebContentsView }: ElectronModule, strip: number): Layout {
  const win = BrowserWindow.getAllWindows()[0]
  const views = (win?.contentView.children ?? []).filter(
    (view): view is InstanceType<typeof WebContentsView> =>
      view instanceof WebContentsView && view.getVisible(),
  )
  const preview = views.find((view) => /^http:\/\/localhost:/.test(view.webContents.getURL()))
  const strips = views
    .filter((view) => view.webContents.getURL() === 'about:blank')
    .map((view) => view.getBounds())
    .filter((bounds) => bounds.width === strip || bounds.height === strip)
    .map((bounds) => ({ axis: bounds.height === strip ? ('y' as const) : ('x' as const), bounds }))
  return { preview: preview?.getBounds() ?? null, strips }
}

/**
 * Runs in main: real input to the window's chrome, the preview, or the strip of the guide on
 * `axis`, as the user's pointer and keys would give it (points in that view's coordinates).
 */
function input(
  { BrowserWindow, WebContentsView }: ElectronModule,
  { to, events }: { to: 'chrome' | 'preview' | RulerGuide['axis']; events: InputEvent[] },
) {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('No window')
  const views = win.contentView.children.filter(
    (view): view is InstanceType<typeof WebContentsView> =>
      view instanceof WebContentsView && view.getVisible(),
  )
  const target =
    to === 'chrome'
      ? win.webContents
      : to === 'preview'
        ? views.find((view) => /^http:\/\/localhost:/.test(view.webContents.getURL()))?.webContents
        : views.find((view) => {
            const { width, height } = view.getBounds()
            return (
              view.webContents.getURL() === 'about:blank' &&
              (to === 'y' ? height === 7 : width === 7)
            )
          })?.webContents
  if (!target) throw new Error(`Nothing to send input to (${to})`)
  if (to === 'preview') target.focus()
  // Hidden windows let only marked moves reach Gui's overlays (window-presentation.ts).
  const marked = globalThis as { guiE2eInput?: boolean }
  marked.guiE2eInput = true
  try {
    for (const event of events) {
      if ('keyCode' in event) {
        target.sendInputEvent({
          type: event.type,
          keyCode: event.keyCode,
          modifiers: event.shift ? ['shift'] : [],
        })
        continue
      }
      const x = Math.round(event.x)
      const y = Math.round(event.y)
      const modifiers: 'leftbuttondown'[] = event.held ? ['leftbuttondown'] : []
      if (event.type === 'mouseMove') target.sendInputEvent({ type: 'mouseMove', x, y, modifiers })
      else target.sendInputEvent({ type: event.type, x, y, button: 'left', clickCount: 1 })
    }
  } finally {
    marked.guiE2eInput = false
  }
}

/** Presses from `from` and moves to `to` in steps, holding the button; `release` lets go there. */
function drag(from: Point, to: Point, release = true): InputEvent[] {
  const steps = 8
  const moves = Array.from({ length: steps }, (_, i) => ({
    type: 'mouseMove' as const,
    x: from.x + ((to.x - from.x) * (i + 1)) / steps,
    y: from.y + ((to.y - from.y) * (i + 1)) / steps,
    held: true,
  }))
  return [
    { type: 'mouseMove', ...from },
    { type: 'mouseDown', ...from },
    ...moves,
    ...(release ? [{ type: 'mouseUp' as const, ...to }] : []),
  ]
}

const shiftR: InputEvent[] = [
  { type: 'keyDown', keyCode: 'R', shift: true },
  { type: 'char', keyCode: 'R', shift: true },
  { type: 'keyUp', keyCode: 'R', shift: true },
]

/** The project's guides as Gui saved them (prefs.json, never the project). */
function savedGuides(session: GuiSession): RulerGuide[] {
  const prefs = JSON.parse(readFileSync(join(session.fixture.userData, 'prefs.json'), 'utf8'))
  return Object.values((prefs.guides ?? {}) as Record<string, RulerGuide[]>)[0] ?? []
}

/** Where an element's edge is on the page, in its CSS pixels (scrolled or not). */
async function pageEdge(session: GuiSession, selector: string, edge: 'top' | 'left') {
  const preview = await session.previewPage()
  return preview
    .locator(selector)
    .evaluate(
      (el, side) =>
        el.getBoundingClientRect()[side] + (side === 'top' ? window.scrollY : window.scrollX),
      edge,
    )
}

test('guides come out of the rulers, keep to the page, move, snap and go back', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const rulers = session.chrome.locator('[data-ruler]')
  const position = session.chrome.locator('[data-ruler-position]')
  const view = () => session.app.evaluate(layout, STRIP)
  const send = (to: 'chrome' | 'preview' | RulerGuide['axis'], events: InputEvent[]) =>
    session.app.evaluate(input, { to, events })

  // ⇧R with the page focused shows the rulers, and the page moves over for them.
  await expect(rulers).toHaveCount(0)
  const before = (await view()).preview
  await send('preview', shiftR)
  await expect(rulers).toHaveCount(2)
  await waitFor(async () => (await view()).preview?.y === (before?.y ?? 0) + 20, 'room for rulers')

  // Out of the top ruler, onto the heading's top edge: a horizontal guide there, in page pixels.
  const top = await session.chrome.locator('[data-ruler="top"]').boundingBox()
  if (!top) throw new Error('No top ruler')
  const { preview } = await view()
  if (!preview) throw new Error('No preview')
  const heading = await session.viewBox('h1')
  const onHeading = { x: preview.x + heading.x + 40, y: preview.y + heading.y }
  await send('chrome', drag({ x: top.x + 200, y: top.y + 10 }, onHeading, false))
  const headingTop = Math.round(await pageEdge(session, 'h1', 'top'))
  await expect(position).toHaveText(`y ${headingTop}`)
  await send('chrome', [{ type: 'mouseUp', ...onHeading }])
  await waitFor(() => savedGuides(session).length === 1, 'the guide to be saved')
  expect(savedGuides(session)).toEqual([{ axis: 'y', at: headingTop }])
  await expect(position).toHaveCount(0)
  const strip = async (axis: RulerGuide['axis']) => {
    const found = (await view()).strips.find((each) => each.axis === axis)
    if (!found) throw new Error(`No ${axis} guide on the page`)
    return found.bounds
  }
  /** Where a guide at `at` page pixels is drawn, `from` the page's edge in the window. */
  const lineAt = async (at: number, from: number, scroll = 0) => {
    const { frame, zoom } = (await session.state()).preview
    return from + Math.floor((at - scroll) * (frame?.scale ?? zoom))
  }
  expect((await strip('y')).y + LINE).toBe(await lineAt(headingTop, preview.y))

  // Hovering the guide shows where it is, on its ruler.
  await send('y', [{ type: 'mouseMove', x: 300, y: LINE }])
  await expect(position).toHaveText(`y ${headingTop}`)
  await session.shot('rulers-desktop-hover')
  await send('y', [{ type: 'mouseMove', x: 300, y: STRIP + 20 }])

  // Another viewport (scaled to fit): the guide is at the same page y, drawn at the new scale;
  // a vertical one out of the left ruler lands on the button's left edge, in page pixels.
  await session.chrome.evaluate(() => window.gui.setViewport('mobile'))
  await waitFor(async () => (await session.state()).preview.frame?.viewport === 'mobile', 'mobile')
  // Guides show again once the frame is at rest (mid-morph they're hidden).
  const mobile = await waitFor(async () => {
    const now = await view()
    const resting = now.strips.some((each) => each.axis === 'y')
    return resting && now.preview && now.preview.width < preview.width ? now.preview : null
  }, 'the mobile frame at rest')
  await waitFor(
    async () => (await strip('y')).y + LINE === (await lineAt(headingTop, mobile.y)),
    'the guide at the heading at the mobile scale',
  )
  const left = await session.chrome.locator('[data-ruler="left"]').boundingBox()
  if (!left) throw new Error('No left ruler')
  const button = await session.viewBox('button.counter')
  const onButton = { x: mobile.x + button.x, y: mobile.y + button.y + button.height / 2 }
  await send('chrome', drag({ x: left.x + 10, y: left.y + 300 }, onButton))
  const buttonLeft = Math.round(await pageEdge(session, 'button.counter', 'left'))
  await waitFor(() => savedGuides(session).length === 2, 'the second guide to be saved')
  expect(savedGuides(session)).toEqual([
    { axis: 'y', at: headingTop },
    { axis: 'x', at: buttonLeft },
  ])
  // Its strip opens a moment after (the guides overlay opens it).
  await waitFor(
    async () =>
      (await view()).strips.some(
        (each) => each.axis === 'x' && each.bounds.x + LINE === Math.floor(mobile.x + button.x),
      ),
    'the vertical guide on the button',
  )
  expect((await strip('x')).x + LINE).toBe(await lineAt(buttonLeft, mobile.x))
  await session.shot('rulers-mobile')

  // Scrolled, the horizontal guide stays on the heading; the vertical one stays put.
  const page = await session.previewPage()
  await page.evaluate(() => {
    document.body.style.minHeight = '3000px'
    window.scrollTo(0, 20)
  })
  await waitFor(
    async () => (await strip('y')).y + LINE === (await lineAt(headingTop, mobile.y, 20)),
    'the guide to scroll with the heading',
  )
  expect((await strip('x')).x + LINE).toBe(await lineAt(buttonLeft, mobile.x))
  await page.evaluate(() => window.scrollTo(0, 0))
  await waitFor(
    async () => (await strip('y')).y + LINE === (await lineAt(headingTop, mobile.y)),
    'the guide back with the heading',
  )

  // Dragged onto the button's top edge, the guide snaps to it.
  const yStrip = await strip('y')
  const buttonNow = await session.viewBox('button.counter')
  const grab = { x: mobile.x + buttonNow.x + 5 - yStrip.x, y: LINE }
  const target = { x: grab.x, y: mobile.y + buttonNow.y + 2 - yStrip.y }
  await send('y', drag(grab, target))
  const buttonTop = Math.round(await pageEdge(session, 'button.counter', 'top'))
  await waitFor(
    () => savedGuides(session).some((guide) => guide.axis === 'y' && guide.at === buttonTop),
    'the guide to snap to the button',
  )

  // Back onto the top ruler, it goes away.
  const moved = await strip('y')
  await send('y', drag({ x: 100, y: LINE }, { x: 100, y: mobile.y - moved.y - 12 }))
  await waitFor(() => savedGuides(session).length === 1, 'the guide to be removed')
  expect(savedGuides(session)).toEqual([{ axis: 'x', at: buttonLeft }])
  expect((await view()).strips.filter((each) => each.axis === 'y')).toHaveLength(0)

  // ⇧R typed into a field in the page types an R; the rulers stay.
  await page.evaluate(() => {
    const field = document.createElement('input')
    field.id = 'typing'
    document.body.prepend(field)
    field.focus()
  })
  await send('preview', shiftR)
  await expect(page.locator('#typing')).toHaveValue('R')
  await expect(rulers).toHaveCount(2)

  // Outside it, ⇧R hides them, and the guides with them; they're kept for next time.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await send('preview', shiftR)
  await expect(rulers).toHaveCount(0)
  await waitFor(async () => (await view()).strips.length === 0, 'the guides to hide')
  await expect(page.locator('#typing')).toHaveValue('R')
  expect(savedGuides(session)).toEqual([{ axis: 'x', at: buttonLeft }])
})
