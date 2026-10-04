import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRAME_LABEL_HEIGHT, FRAME_MARGIN } from '../src/shared/layout'
import {
  type AgentId,
  CUSTOM_AGENT_PREFIX,
  type ElementContext,
  type Rect,
  VIEWPORTS,
  viewportSpec,
} from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Laptop, Tablet and Mobile are device frames: the page lays out at exactly the device's CSS
// size, centered on the canvas and drawn smaller when the canvas can't fit it (Chromium's
// device emulation), while Desktop fills the canvas. Window sizes are set explicitly and
// expectations follow the canvas Gui actually got, since CI's screen is short.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

interface Size {
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

/** Transparent margin around the floating chat panel (PANEL_SHADOW_MARGIN). */
const SHADOW = 18
const SMALL_WINDOW = { width: 960, height: 640 }
const LARGE_WINDOW = { width: 1640, height: 1180 }

/**
 * Runs in main, in a task of its own: the preview and chat views of the first window and
 * its content size.
 */
async function views({ BrowserWindow, WebContentsView }: ElectronModule) {
  await new Promise<void>((resolve) => setImmediate(() => resolve()))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const children = win.contentView.children.filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const preview = children.find((view) => /^https?:\/\//.test(view.webContents.getURL()))
  const chat = children.find((view) => view.webContents.getURL().endsWith('/chat.html'))
  if (!preview) return null
  const [width = 0, height = 0] = win.getContentSize()
  return {
    preview: preview.getBounds(),
    chat: chat?.getVisible() ? chat.getBounds() : null,
    content: { width, height },
  }
}

function setContentSize({ BrowserWindow }: ElectronModule, size: Size) {
  BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
}

/**
 * Runs in main: the size the preview's page lays itself out at. Read through main so it
 * works across a renderer crash, which leaves Playwright's page for it closed.
 */
async function pageSize({ webContents }: ElectronModule): Promise<Size | null> {
  const preview = webContents.getAllWebContents().find((wc) => /^https?:\/\//.test(wc.getURL()))
  if (!preview || preview.isCrashed()) return null
  return preview.executeJavaScript('({ width: innerWidth, height: innerHeight })')
}

/** Runs in main: a click at `point` in the preview view, through the input pipeline. */
function clickPreview({ webContents }: ElectronModule, point: Point) {
  const preview = webContents.getAllWebContents().find((wc) => /^https?:\/\//.test(wc.getURL()))
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  preview?.sendInputEvent({ type: 'mouseMove', x, y })
  preview?.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  preview?.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/** Runs in main: the pointer to `point` in the preview view. */
function movePointer({ webContents }: ElectronModule, point: Point) {
  const preview = webContents.getAllWebContents().find((wc) => /^https?:\/\//.test(wc.getURL()))
  preview?.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) })
}

/** Runs in main: the preview view as it's drawn on screen, and its width in the window. */
async function previewImage({ BrowserWindow, WebContentsView }: ElectronModule) {
  const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
    (child): child is InstanceType<typeof WebContentsView> =>
      child instanceof WebContentsView && /^https?:\/\//.test(child.webContents.getURL()),
  )
  if (!view) return null
  const image = await view.webContents.capturePage()
  return { url: image.toDataURL(), width: view.getBounds().width }
}

/**
 * Runs in the chrome page: an image's pixel size and its color at `at`, a point in an
 * image `width` wide (the image's own pixels, or the view's coordinates for a capture).
 */
async function pixel({ url, at, width }: { url: string; at: Point; width?: number }) {
  const image = new Image()
  image.src = url
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2d canvas is unavailable')
  context.drawImage(image, 0, 0)
  const density = image.naturalWidth / (width ?? image.naturalWidth)
  const x = Math.round(at.x * density)
  const y = Math.round(at.y * density)
  const [r = 0, g = 0, b = 0] = context.getImageData(x, y, 1, 1).data
  return { width: image.naturalWidth, height: image.naturalHeight, color: [r, g, b] }
}

/** The preview's color at `point` (view coordinates), as it's drawn on screen. */
async function viewColor(session: GuiSession, point: Point) {
  const shot = await session.app.evaluate(previewImage)
  if (!shot) return null
  return (await session.chrome.evaluate(pixel, { url: shot.url, at: point, width: shot.width }))
    .color
}

/** Runs in main: the View menu's viewport items, with their shortcuts. */
function viewportItems({ Menu }: ElectronModule) {
  const view = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View')
  return (view?.submenu?.items ?? [])
    .filter((item) => item.label.endsWith(' Viewport'))
    .map((item) => ({ label: item.label, accelerator: item.accelerator ?? null }))
}

/** Clicks a visible item of the app menu by label, as the user would in the menu bar. */
function clickMenu(session: GuiSession, label: string) {
  return session.app.evaluate(({ Menu }, name) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === name && item.visible) return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item) throw new Error(`No menu item "${name}"`)
    item.click()
  }, label)
}

const difference = (a: number[] | null, b: number[] | null) =>
  a && b ? a.reduce((sum, value, i) => sum + Math.abs(value - (b[i] ?? 0)), 0) : Infinity

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** The visible panel: the chat view without its shadow margin. */
const inner = (view: Rect): Rect => ({
  x: view.x + SHADOW,
  y: view.y + SHADOW,
  width: view.width - SHADOW * 2,
  height: view.height - SHADOW * 2,
})

/** The canvas as the chrome lays it out, in window coordinates. */
function canvasRect(session: GuiSession): Promise<Rect> {
  return session.chrome.evaluate(() => {
    const main = document.querySelector('main')
    if (!main) throw new Error('No canvas')
    const { x, y, width, height } = main.getBoundingClientRect()
    return { x, y, width, height }
  })
}

/**
 * Where a frame of `size` belongs on `canvas`: its label and itself centered together, a
 * margin from the edges, scaled down to fit (never up). The scale is in thousandths.
 */
function expectedFrame(canvas: Rect, size: Size) {
  const fit = Math.min(
    1,
    (canvas.width - FRAME_MARGIN * 2) / size.width,
    (canvas.height - FRAME_MARGIN * 2 - FRAME_LABEL_HEIGHT) / size.height,
  )
  const scale = Math.floor(fit * 1000) / 1000
  const width = size.width * scale
  const height = size.height * scale
  return {
    scale,
    x: canvas.x + (canvas.width - width) / 2,
    y: canvas.y + FRAME_LABEL_HEIGHT + (canvas.height - FRAME_LABEL_HEIGHT - height) / 2,
    width,
    height,
  }
}

const frameLabel = (session: GuiSession) => session.chrome.locator('main p').first()

/** Waits for the page to lay out at `size`, and returns the layout then. */
async function pageAt(session: GuiSession, size: Size, label: string) {
  return waitFor(async () => {
    const page = await session.app.evaluate(pageSize)
    if (page?.width !== size.width || page.height !== size.height) return null
    const layout = await session.app.evaluate(views)
    const { frame } = (await session.state()).preview
    return layout ? { ...layout, frame } : null
  }, label)
}

/**
 * Checks a device frame against the canvas the chrome has now (less the chat, `docked`): the
 * page at the device's CSS size, the view centered at the expected scale, the chrome's label
 * and frame state matching.
 */
async function expectFrame(
  session: GuiSession,
  id: 'laptop' | 'tablet' | 'mobile',
  { docked = false } = {},
) {
  const { name, size } = viewportSpec(id)
  if (!size) throw new Error(`${id} has no size`)
  // Settled: the page at its size, and the view where the current canvas puts it.
  const settled = await waitFor(async () => {
    const at = await pageAt(session, size, `${name} at ${size.width}×${size.height}`)
    const canvas = await canvasRect(session)
    const { preview, frame, chat } = at
    if (docked && !chat) return null
    const area = docked && chat ? { ...canvas, width: chat.x - canvas.x } : canvas
    const expected = expectedFrame(area, size)
    const placed =
      frame !== null &&
      Math.abs(frame.scale - expected.scale) < 0.0011 &&
      Math.abs(preview.x - expected.x) <= 1 &&
      Math.abs(preview.y - expected.y) <= 1 &&
      Math.abs(preview.width - expected.width) <= 1 &&
      Math.abs(preview.height - expected.height) <= 1
    return placed ? { ...at, frame, canvas, expected } : null
  }, `the ${name} frame centered on the canvas`)
  const { frame, preview, canvas } = settled
  // The chrome draws around the view: the frame's rect is the view's, on the canvas.
  expect(frame.rect).toEqual({
    x: preview.x - canvas.x,
    y: preview.y - canvas.y,
    width: preview.width,
    height: preview.height,
  })
  expect(preview.x).toBeGreaterThanOrEqual(canvas.x + FRAME_MARGIN - 1)
  expect(preview.x + preview.width).toBeLessThanOrEqual(canvas.x + canvas.width - FRAME_MARGIN + 1)
  expect(preview.y + preview.height).toBeLessThanOrEqual(
    canvas.y + canvas.height - FRAME_MARGIN + 1,
  )
  const percent = Math.floor(frame.scale * 100)
  const scaled = percent < 100 ? ` · ${percent}%` : ''
  await expect(frameLabel(session)).toHaveText(`${name} · ${size.width} × ${size.height}${scaled}`)
  return settled
}

test('each viewport lays the page out at its device size, scaled to fit the window', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()

  // Desktop · Laptop · Tablet · Mobile on ⌘1–⌘4, in the View menu and the toolbar.
  expect(await session.app.evaluate(viewportItems)).toEqual([
    { label: 'Desktop Viewport', accelerator: 'CmdOrCtrl+1' },
    { label: 'Laptop Viewport', accelerator: 'CmdOrCtrl+2' },
    { label: 'Tablet Viewport', accelerator: 'CmdOrCtrl+3' },
    { label: 'Mobile Viewport', accelerator: 'CmdOrCtrl+4' },
  ])
  const segments = session.chrome.getByRole('group', { name: 'Viewport' }).getByRole('button')
  await expect(segments).toHaveCount(4)
  for (const [i, { name }] of VIEWPORTS.entries()) {
    await expect(segments.nth(i)).toHaveAccessibleName(name)
    await expect(segments.nth(i)).toHaveAttribute('aria-keyshortcuts', `Meta+${i + 1}`)
  }
  await expect(segments.nth(1)).toHaveAttribute('title', 'Laptop · 1440 × 900 (⌘2)')
  await expect(segments.nth(0)).toHaveAttribute('aria-pressed', 'true')

  // As large as the screen allows: whatever the canvas, the page is exactly the device's size.
  await session.app.evaluate(setContentSize, LARGE_WINDOW)
  await sleep(300)
  await segments.nth(1).click()
  await expect(segments.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expectFrame(session, 'laptop')
  await session.shot('laptop-large')
  await clickMenu(session, 'Tablet Viewport')
  await expectFrame(session, 'tablet')
  await clickMenu(session, 'Mobile Viewport')
  await expectFrame(session, 'mobile')
  // A phone: the page's <meta name=viewport> applies, and it sees a touch screen.
  const preview = await session.previewPage()
  const touch = await preview.evaluate(() => ({
    coarse: matchMedia('(pointer: coarse)').matches,
    points: navigator.maxTouchPoints,
  }))
  expect(touch).toEqual({ coarse: true, points: 5 })
  await session.shot('mobile-large')

  // A window smaller than a laptop's screen draws the laptop smaller; it's still 1440×900.
  await clickMenu(session, 'Laptop Viewport')
  await session.app.evaluate(setContentSize, SMALL_WINDOW)
  const small = await expectFrame(session, 'laptop')
  expect(small.frame.scale).toBeLessThan(1)
  expect(await preview.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false)
  await session.shot('laptop-small')

  // The logs drawer and a docked chat leave less room: smaller again, the same page.
  await session.chrome.evaluate(() => window.gui.showLogs())
  const logs = await expectFrame(session, 'laptop')
  expect(logs.frame.scale).toBeLessThan(small.frame.scale)
  await session.chrome.evaluate(() => window.gui.setDrawerOpen(false))
  await session.chat.evaluate(() => window.gui.toggleDock())
  const docked = await expectFrame(session, 'laptop', { docked: true })
  const chat = docked.chat
  if (!chat) throw new Error('The docked chat is hidden')
  expect(docked.preview.x + docked.preview.width).toBeLessThanOrEqual(chat.x - FRAME_MARGIN + 1)
  await session.chat.evaluate(() => window.gui.toggleDock())
  await expectFrame(session, 'laptop')

  // A reload, or a renderer that crashed and came back, keeps the device's size.
  await session.chrome.evaluate(() => window.gui.reload())
  await sleep(500)
  await expectFrame(session, 'laptop')

  // Per tab: a new tab starts on Desktop, and this one is still a laptop when it's back.
  await session.chrome.evaluate(() => window.gui.newTab())
  await waitFor(async () => (await session.state()).tabs.length === 2, 'the second tab')
  const other = (await session.state()).preview
  expect(other.viewport).toBe('desktop')
  expect(other.frame).toBeNull()
  const first = (await session.state()).tabs[0]?.id ?? ''
  await session.chrome.evaluate((id) => window.gui.selectTab(id), first)
  expect((await session.state()).preview.viewport).toBe('laptop')
  await expectFrame(session, 'laptop')

  // Desktop clears the emulation: the page is the view's size again, and fills the canvas.
  await segments.nth(0).click()
  const desktop = await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const page = await session.app.evaluate(pageSize)
    const canvas = await canvasRect(session)
    if (!layout || !page) return null
    const fills = layout.preview.width === Math.round(canvas.width)
    const matches = page.width === layout.preview.width && page.height === layout.preview.height
    return fills && matches ? { layout, page } : null
  }, 'the desktop page at the view size')
  expect(desktop.page.width).toBe(desktop.layout.content.width)
  expect((await session.state()).preview.frame).toBeNull()
  await expect(frameLabel(session)).toHaveCount(0)

  await clickMenu(session, 'Mobile Viewport')
  await expectFrame(session, 'mobile')
  await session.app.evaluate(({ webContents }) => {
    const preview = webContents.getAllWebContents().find((wc) => /^https?:/.test(wc.getURL()))
    preview?.forcefullyCrashRenderer()
  })
  await waitFor(async () => (await session.state()).preview.error, 'the crash')
  await session.chrome.evaluate(() => window.gui.reload())
  await waitFor(async () => (await session.state()).preview.visible, 'the preview again')
  await expectFrame(session, 'mobile')
})

/** Picks what's at `point` (view coordinates) with real input, as the user's click would. */
async function pickAt(session: GuiSession, point: Point): Promise<ElementContext> {
  const before = (await session.chatSnapshot()).meta.selection?.id ?? null
  await session.chrome.evaluate(() => window.gui.toggleSelect())
  await waitFor(async () => (await session.state()).preview.selecting, 'selection mode')
  // `selecting` flips before inspect mode is armed: a click too early presses the page.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(500)
    await session.app.evaluate(clickPreview, point)
    const picked = await waitFor(
      async () => {
        const { meta } = await session.chatSnapshot()
        if (meta.selectionError) throw new Error(meta.selectionError)
        return meta.selection && meta.selection.id !== before ? meta.selection : null
      },
      'a selection',
      { timeout: 8_000, interval: 200 },
    ).catch(() => null)
    if (picked) return picked
  }
  throw new Error('Clicking in selection mode never produced a selection')
}

test('picking in a scaled frame finds, highlights and frames the right element', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await session.app.evaluate(setContentSize, SMALL_WINDOW)
  await clickMenu(session, 'Laptop Viewport')
  const { frame } = await expectFrame(session, 'laptop')
  const { scale } = frame
  expect(scale).toBeLessThan(1)
  const preview = await session.previewPage()
  const button = await preview.locator('button.counter').boundingBox()
  if (!button) throw new Error('The button has no layout box')

  // In the button's padding, where the page draws it at the frame's scale.
  const inButton = { x: button.x + 4, y: button.y + button.height / 2 }
  const onScreen = (point: Point) => ({ x: point.x * scale, y: point.y * scale })
  // The same page coordinates without the scale: page below the button, not the button.
  const unscaled = { x: inButton.x, y: inButton.y }
  const plain = await viewColor(session, onScreen(inButton))
  const blank = await viewColor(session, unscaled)

  const selection = await pickAt(session, onScreen(inButton))
  expect(selection.tag).toBe('button')
  expect(selection.text).toContain('count is')
  expect(selection.viewport).toEqual({ width: 1440, height: 900 })
  // Page coordinates, as the agent measures: unaffected by how large the frame is drawn.
  expect(selection.rect.x).toBeCloseTo(button.x, 1)
  expect(selection.rect.width).toBeCloseTo(button.width, 1)

  // The highlight is over the button as drawn, and nowhere it would be unscaled.
  await waitFor(async () => {
    const color = await viewColor(session, onScreen(inButton))
    return difference(color, plain) > 15
  }, 'the highlight over the button')
  expect(difference(await viewColor(session, unscaled), blank)).toBeLessThan(6)

  // The crop shows the button where its area says, at the frame's scale of the display's pixels.
  const crop = selection.crop
  if (!crop || !selection.screenshot) throw new Error('The pick has no crop')
  const dpr = await preview.evaluate(() => devicePixelRatio)
  const probe = await session.chrome.evaluate(pixel, {
    url: selection.screenshot,
    at: {
      x: (inButton.x - crop.area.x) * scale * dpr,
      y: (inButton.y - crop.area.y) * scale * dpr,
    },
  })
  expect(Math.abs(probe.width - crop.area.width * scale * dpr)).toBeLessThanOrEqual(2)
  expect(difference(probe.color, plain)).toBeLessThan(12)
  await session.shot('picked-scaled')

  // An element far from the page's origin, under the floating chat as drawn: the chat moves
  // off it. (Unscaled, the element would be past the window's right edge.)
  await preview.evaluate(() => {
    const far = document.createElement('button')
    far.id = 'far'
    far.textContent = 'Far'
    far.style.cssText =
      'position:absolute;left:900px;top:560px;width:200px;height:80px;background:#e2e8f0;border:0'
    document.body.append(far)
  })
  const layout = await session.app.evaluate(views)
  if (!layout?.chat) throw new Error('The chat is hidden')
  const element = {
    x: layout.preview.x + 900 * scale,
    y: layout.preview.y + 560 * scale,
    width: 200 * scale,
    height: 80 * scale,
  }
  const panel = inner(layout.chat)
  const dx = element.x + element.width / 2 - (panel.x + panel.width / 2)
  const dy = element.y + element.height / 2 - (panel.y + panel.height / 2)
  await session.chat.evaluate(
    ({ dx, dy }) => {
      window.gui.dragChat(dx, dy)
      window.gui.endDragChat()
    },
    { dx, dy },
  )
  await waitFor(async () => {
    const chat = (await session.app.evaluate(views))?.chat
    return chat && overlaps(inner(chat), element)
  }, 'the chat over the far element')
  const far = await pickAt(session, onScreen({ x: 1000, y: 600 }))
  expect(far.attributes.id).toBe('far')
  await waitFor(async () => {
    const chat = (await session.app.evaluate(views))?.chat
    return chat && chat.width > 100 && !overlaps(inner(chat), element)
  }, 'the chat off the far element')
  await session.shot('dodged-scaled')

  // A phone sees a touch screen, but the mouse stays a mouse: it hovers, and it picks. (Without
  // the far element, which a phone would zoom out to show.)
  await preview.evaluate(() => document.getElementById('far')?.remove())
  await clickMenu(session, 'Mobile Viewport')
  const phone = (await expectFrame(session, 'mobile')).frame.scale
  const counter = await preview.locator('button.counter').boundingBox()
  if (!counter) throw new Error('The button has no layout box')
  const center = {
    x: (counter.x + counter.width / 2) * phone,
    y: (counter.y + counter.height / 2) * phone,
  }
  await session.app.evaluate(movePointer, center)
  await expect(preview.locator('button.counter:hover')).toHaveCount(1)
  const tapped = await pickAt(session, center)
  expect(tapped.tag).toBe('button')
  expect(tapped.viewport).toEqual({ width: 390, height: 844 })
})

// A stand-in ACP agent (a small Node script run by Electron) with Gui's preview tools: it
// echoes the prompt it gets, calls preview_screenshot through Gui's MCP server, or edits a
// file, so this runs without an agent login or usage.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Viewports`

const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const say = (sessionId, text) =>
  write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
let mcp = null
let cwd = ''

const callTool = async (name, args) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const header of mcp.headers) headers[header.name] = header.value
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const response = await fetch(mcp.url, { method: 'POST', headers, body })
  const reply = await response.json()
  if (reply.error) throw new Error(reply.error.message)
  return reply.result
}

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const shot = /SHOT (\{[^\n]*\})/.exec(text)
  if (shot) {
    const result = await callTool('preview_screenshot', JSON.parse(shot[1]))
    const image = result.content.find((item) => item.type === 'image')
    const note = result.content.find((item) => item.type === 'text')
    const png = Buffer.from(image ? image.data : '', 'base64')
    const size = png.length > 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null
    say(sessionId, JSON.stringify({ note: note ? note.text : null, size }))
  } else if (text.includes('EDIT')) {
    appendFileSync(join(cwd, 'src', 'index.css'), '\n.counter { color: #b91c1c; }\n')
    say(sessionId, 'Edited.')
  } else {
    say(sessionId, text)
  }
  return { stopReason: 'end_turn' }
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined || id === undefined) return
  if (method === 'initialize') {
    const agentCapabilities = { mcpCapabilities: { http: true }, promptCapabilities: { image: true } }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') {
    cwd = params.cwd
    mcp = params.mcpServers.find((server) => server.url) || null
    return write({ id, result: { sessionId: 'session-' + process.pid } })
  }
  if (method === 'session/prompt') {
    prompt(params).then(
      (result) => write({ id, result }),
      (error) => write({ id, error: { code: -32603, message: error.message } }),
    )
    return
  }
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

/** Adds the stand-in to agents.json, waits for Gui to list it, and selects it. */
async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'viewports-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Viewports: {
      command: electronExecutable(),
      args: [script],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(session.fixture.userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the stand-in agent to be listed')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === AGENT
  await waitFor(selected, 'the stand-in agent to be selected')
}

/** Sends `text` and returns what the stand-in answered. */
async function ask(session: GuiSession, text: string) {
  const index = (await session.chatSnapshot()).turns.length
  expect(await session.chat.evaluate((message) => window.gui.send(message), text)).toBe(true)
  const { turn } = await session.waitForTurn(index)
  expect(turn.status, turn.error ?? '').toBe('done')
  const answer = turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
  return { turn, answer }
}

interface ShotReply {
  note: string | null
  size: Size | null
}

test("the agent is told the viewport, and its screenshots are the device's size", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await useStandIn(session)
  await session.waitForPreview()
  await session.app.evaluate(setContentSize, SMALL_WINDOW)
  await clickMenu(session, 'Laptop Viewport')
  const { frame } = await expectFrame(session, 'laptop')
  expect(frame.scale).toBeLessThan(1)

  // Every prompt names the viewport the user is looking at.
  const echo = await ask(session, 'Make the hero shorter on this screen')
  expect(echo.answer).toContain(
    'The user is viewing the preview in its Laptop viewport (1440×900 CSS px).',
  )

  // preview_screenshot captures what the user sees, at the device's CSS size: the visible
  // 1440×900, scaled only to fit the agent's image limit, never to the frame's scale.
  const dpr = await (await session.previewPage()).evaluate(() => devicePixelRatio)
  const fitted = Math.min(1, 1600 / (1440 * dpr), 1960 / (900 * dpr))
  const shot = JSON.parse((await ask(session, 'SHOT {}')).answer) as ShotReply
  expect(shot.note).toMatch(/^viewport at viewport width 1440px /)
  expect(shot.size?.width).toBe(Math.round(1440 * fitted * dpr))
  expect(shot.size?.height).toBe(Math.round(900 * fitted * dpr))

  // A width of its own is emulated for the capture, then the laptop comes back.
  const narrow = JSON.parse((await ask(session, 'SHOT {"width":390}')).answer) as ShotReply
  expect(narrow.note).toMatch(/^viewport at viewport width 390px /)
  await expectFrame(session, 'laptop')

  // The before and after images of an edited element frame it the same way when scaled.
  // (Picked with real input: Playwright's protocol clicks don't follow the frame's scale.)
  const button = await (await session.previewPage()).locator('button.counter').boundingBox()
  if (!button) throw new Error('The button has no layout box')
  const picked = await pickAt(session, {
    x: (button.x + button.width / 2) * frame.scale,
    y: (button.y + button.height / 2) * frame.scale,
  })
  expect(picked.tag).toBe('button')
  const edit = await ask(session, 'EDIT the button color')
  const preview = await waitFor(async () => {
    const turn = (await session.chatSnapshot()).turns[edit.turn.index]
    return turn?.preview?.after ? turn.preview : null
  }, "the edited element's after image")
  expect(preview.frame ?? null).toBeNull()
  const before = await session.chrome.evaluate(pixel, {
    url: preview.before ?? '',
    at: { x: 0, y: 0 },
  })
  const after = await session.chrome.evaluate(pixel, {
    url: preview.after ?? '',
    at: { x: 0, y: 0 },
  })
  expect(Math.abs(before.width / before.height - after.width / after.height)).toBeLessThan(0.05)
  await session.shot('edited-scaled')
})
