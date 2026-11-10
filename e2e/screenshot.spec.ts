import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ImageAttachment, PanelEdge } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** Transparent margin around the floating chat panel (SHADOW in window.ts). */
const SHADOW = 18
/** The toolbar the floating panel stays below (TOOLBAR_HEIGHT in window.ts). */
const TOOLBAR_HEIGHT = 44
/** How far from the canvas's corner the floating panel starts (PANEL_MARGIN in window.ts). */
const PANEL_MARGIN = 12
const PNG_SIGNATURE = '89504e470d0a1a0a'

interface Size {
  width: number
  height: number
}

/** State the main-process stubs below keep on `globalThis`. */
interface StubStore {
  /** Label of the screenshot menu item to choose next; any other label dismisses the menu */
  guiMenuChoice?: string | null
  guiMenuStubbed?: boolean
  guiClipboard?: (Size & { types: string[]; signature: string })[]
  guiSaveDefault?: string | null
}

/**
 * Runs in main: answers the next screenshot menu with `label` instead of showing it. The
 * real menu is built from the real template; only `popup`, which no test can click, is
 * replaced. Like Electron, it runs the chosen item's click before the close callback.
 */
function answerScreenshotMenu({ Menu }: ElectronModule, label: string) {
  const store = globalThis as unknown as StubStore
  store.guiMenuChoice = label
  if (store.guiMenuStubbed) return
  store.guiMenuStubbed = true
  const build = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = (template) => {
    const menu = build(template)
    const choice = store.guiMenuChoice
    if (!choice || !menu.items.some((item) => item.label === 'Copy Screenshot')) return menu
    menu.popup = (options) => {
      store.guiMenuChoice = null
      menu.items.find((item) => item.label === choice && item.enabled)?.click()
      options?.callback?.()
    }
    return menu
  }
}

/**
 * Runs in main: records clipboard writes instead of making them, with each PNG's size
 * (from its IHDR chunk) and the bytes' signature.
 */
function recordClipboard({ clipboard }: ElectronModule) {
  const store = globalThis as unknown as StubStore
  store.guiClipboard = []
  clipboard.write = async (items) => {
    for (const item of items) {
      const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer())
      store.guiClipboard?.push({
        types: item.types,
        signature: png.subarray(0, 8).toString('hex'),
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
      })
    }
  }
}

/** Runs in main: the save panel "chooses" `filePath` and records the suggested one. */
function answerSaveDialog({ dialog }: ElectronModule, filePath: string) {
  const store = globalThis as unknown as StubStore
  dialog.showSaveDialog = ((...args: unknown[]) => {
    const options = args.at(-1) as { defaultPath?: string } | undefined
    store.guiSaveDefault = options?.defaultPath ?? null
    return Promise.resolve({ canceled: false, filePath })
  }) as typeof dialog.showSaveDialog
}

function stubs(session: GuiSession) {
  return session.app.evaluate(() => {
    const { guiClipboard = [], guiSaveDefault = null } = globalThis as unknown as StubStore
    return { clipboard: guiClipboard, saveDefault: guiSaveDefault }
  })
}

/** The toolbar's button, with the menu answered by `label`. */
async function takeScreenshot(session: GuiSession, label: string) {
  await session.app.evaluate(answerScreenshotMenu, label)
  return session.chrome.evaluate(() => window.gui.takeScreenshot())
}

/** Runs in the preview: the visible area and the whole page, in device pixels. */
function previewSize() {
  const dpr = devicePixelRatio
  const root = document.documentElement
  const viewport = visualViewport ?? { width: root.clientWidth, height: root.clientHeight }
  return {
    dpr,
    visible: { width: Math.round(viewport.width * dpr), height: Math.round(viewport.height * dpr) },
    page: {
      width: Math.round(root.scrollWidth * dpr),
      height: Math.round(root.scrollHeight * dpr),
    },
  }
}

/** Runs in the chat page: the pixel size of an image URL. */
async function imageSize(url: string) {
  const img = new Image()
  img.src = url
  await img.decode()
  return { width: img.naturalWidth, height: img.naturalHeight }
}

function expectSize(actual: Size | undefined, expected: Size, label: string) {
  expect(actual, label).toBeDefined()
  expect(Math.abs((actual?.width ?? 0) - expected.width), `${label} width`).toBeLessThanOrEqual(1)
  expect(Math.abs((actual?.height ?? 0) - expected.height), `${label} height`).toBeLessThanOrEqual(
    1,
  )
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: Buffer): Size {
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) }
}

// The native menu can't be clicked from a test, so each case answers it from main (see
// answerScreenshotMenu) and goes through the real path: window.gui.takeScreenshot() →
// ProjectWindow.screenshotMenu() → capture → clipboard, file or composer.
test('screenshots copy, save and attach the preview at full resolution', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const preview = await session.previewPage()
  await expect(preview.locator('h1')).toBeVisible({ timeout: 30_000 })
  await session.app.evaluate(recordClipboard)

  // Closing the menu without a choice does nothing.
  expect(await takeScreenshot(session, 'Nothing')).toBeNull()
  expect((await stubs(session)).clipboard).toHaveLength(0)

  // The visible area, in device pixels: nothing downscaled for the agent.
  const size = await preview.evaluate(previewSize)
  expect(await takeScreenshot(session, 'Copy Screenshot')).toBe('copied')
  const [visible] = (await stubs(session)).clipboard
  expect(visible?.types).toEqual(['image/png'])
  expect(visible?.signature).toBe(PNG_SIGNATURE)
  expectSize(visible, size.visible, 'copied screenshot')

  // A page taller than the window comes out whole, up to the compositor's texture limit.
  await preview.evaluate(() => {
    document.body.style.height = '3000px'
  })
  const tall = await preview.evaluate(previewSize)
  expect(await takeScreenshot(session, 'Copy Full Page')).toBe('copied')
  const fullPage = (await stubs(session)).clipboard[1]
  expectSize(
    fullPage,
    { width: tall.page.width, height: Math.min(tall.page.height, 16_384) },
    'full page',
  )
  expect(fullPage?.height ?? 0).toBeGreaterThan(tall.visible.height)

  // Saved as a PNG, suggested on the Desktop under a macOS-style name.
  const savedPath = join(session.fixture.base, 'saved-screenshot.png')
  await session.app.evaluate(answerSaveDialog, savedPath)
  expect(await takeScreenshot(session, 'Save Screenshot…')).toBe('saved')
  const saved = readFileSync(savedPath)
  expect(saved.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
  expectSize(pngSize(saved), tall.visible, 'saved screenshot')
  const suggested = (await stubs(session)).saveDefault ?? ''
  expect(dirname(suggested)).toBe(join(homedir(), 'Desktop'))
  expect(basename(suggested)).toMatch(/ \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/)

  // Attached to the composer as the composer would attach an image.
  await session.chat.evaluate(() => {
    const store = window as unknown as { guiAttached?: ImageAttachment[] }
    store.guiAttached = []
    window.gui.onChatAttach((image) => store.guiAttached?.push(image))
  })
  expect(await takeScreenshot(session, 'Attach to Chat')).toBe('attached')
  const attached = await waitFor(
    () =>
      session.chat.evaluate(() => {
        const store = window as unknown as { guiAttached?: ImageAttachment[] }
        return store.guiAttached?.[0] ?? null
      }),
    'the attached screenshot',
  )
  expect(attached.mimeType).toMatch(/^image\/(png|jpeg)$/)
  expect(attached.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  expect(attached.data.length).toBeLessThanOrEqual(7 * 1024 * 1024)
  expect(attached.thumbnail).toMatch(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
  expect(attached.thumbnail.length).toBeLessThanOrEqual(256 * 1024)
  const full = await session.chat.evaluate(
    imageSize,
    `data:${attached.mimeType};base64,${attached.data}`,
  )
  expect(Math.max(full.width, full.height)).toBe(
    Math.min(1568, Math.max(tall.visible.width, tall.visible.height)),
  )
  const thumb = await session.chat.evaluate(imageSize, attached.thumbnail)
  expect(Math.max(thumb.width, thumb.height)).toBe(160)

  const list = session.chat.getByRole('list', { name: 'Attached images' })
  await expect(list.getByRole('img', { name: attached.name })).toBeVisible()
  expect((await session.state()).chatVisible).toBe(true)

  // Main accepts it as a message image (index.ts validates everything it's sent). Cancelled
  // while the agent starts, so no prompt reaches an agent (as in images.spec.ts).
  await session.chat.getByRole('button', { name: 'Send' }).click()
  const started = async () => (await session.chatSnapshot()).turns.length > 0
  await waitFor(started, 'the turn to start', { timeout: 10_000, interval: 25 })
  await session.chat.evaluate(() => window.gui.cancel())
  const { turn } = await session.waitForTurn(0, 30_000)
  expect(turn.attachments).toEqual([{ name: attached.name, thumbnail: attached.thumbnail }])
})

/** Runs in main: resizes the window. */
function setWindowSize({ BrowserWindow }: ElectronModule, size: Size) {
  BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
}

// A device frame draws the page smaller when the window can't fit it; a screenshot is still
// the page at the device's CSS size, in the display's pixels, and the frame stays as it was.
test("a device frame's screenshot is the device's size at full resolution", async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const preview = await session.previewPage()
  await expect(preview.locator('h1')).toBeVisible({ timeout: 30_000 })
  await session.app.evaluate(recordClipboard)
  // Smaller than a laptop's screen, on any display.
  await session.app.evaluate(setWindowSize, { width: 960, height: 640 })

  const cases = [
    { viewport: 'laptop', size: { width: 1440, height: 900 } },
    { viewport: 'mobile', size: { width: 390, height: 844 } },
  ] as const
  for (const [i, { viewport, size }] of cases.entries()) {
    await session.chrome.evaluate((id) => window.gui.setViewport(id), viewport)
    const framed = async () => {
      const { frame } = (await session.state()).preview
      const page = await preview.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      return frame && frame.scale < 1 && page.width === size.width && page.height === size.height
    }
    await waitFor(framed, `the ${viewport} frame, scaled down`)
    const { dpr } = await preview.evaluate(previewSize)
    expect(await takeScreenshot(session, 'Copy Screenshot')).toBe('copied')
    const shot = (await stubs(session)).clipboard[i]
    expectSize(
      shot,
      { width: Math.round(size.width * dpr), height: Math.round(size.height * dpr) },
      `${viewport} screenshot`,
    )
    expect(await framed()).toBe(true)
  }
})

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Runs in main: the chat and preview views' bounds and the window's content size, read in a
 * task of their own. The inspector runs an evaluate as soon as it arrives, even in the middle
 * of main's own code, such as between a layout's preview and chat `setBounds`, where the
 * preview has moved and the chat not yet.
 */
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
  // Mid-morph the preview resizes on its way (preview-morph.ts): not where it's going yet.
  if ((globalThis as { guiMorphing?: Set<number> }).guiMorphing?.size) return null
  const [width = 0, height = 0] = win.getContentSize()
  return { chat: chat.getBounds(), preview: preview.getBounds(), content: { width, height } }
}

type Layout = NonNullable<Awaited<ReturnType<typeof chatLayout>>>

/** Waits for the layout to satisfy `check`. */
function layoutWhen(session: GuiSession, label: string, check: (layout: Layout) => boolean) {
  return waitFor(async () => {
    const layout = await session.app.evaluate(chatLayout)
    return layout && check(layout) ? layout : null
  }, label)
}

/** Waits for the chat view's bounds to satisfy `check`. */
function layoutWhere(session: GuiSession, label: string, check: (chat: Bounds) => boolean) {
  return layoutWhen(session, label, (layout) => check(layout.chat))
}

function savedPrefs(session: GuiSession) {
  const file = join(session.fixture.userData, 'prefs.json')
  return JSON.parse(readFileSync(file, 'utf8')) as {
    chatSize?: Size
    chatSidebarWidth?: number
    chatCorner?: { x: string; y: string }
  }
}

function resize(session: GuiSession, edge: PanelEdge, dx: number, dy: number) {
  return session.chat.evaluate(
    ({ edge, dx, dy }) => {
      window.gui.resizeChat(edge, dx, dy)
      window.gui.endResizeChat()
    },
    { edge, dx, dy },
  )
}

const sameBounds = (a: Bounds, b: Bounds) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/**
 * Resizes the floating panel from `edge` and waits for it to follow: the dragged edges move
 * by the pointer's delta and the others stay where they were.
 */
async function resizeFrom(
  session: GuiSession,
  before: Bounds,
  edge: PanelEdge,
  dx: number,
  dy: number,
) {
  const left = edge.includes('left') ? dx : 0
  const right = edge.includes('right') ? dx : 0
  const top = edge.startsWith('top') ? dy : 0
  const bottom = edge.startsWith('bottom') ? dy : 0
  await resize(session, edge, dx, dy)
  const after = await layoutWhere(
    session,
    `the panel resized from its ${edge}`,
    (chat) => !sameBounds(chat, before),
  )
  expect(after.chat, `resized from its ${edge} by ${dx}, ${dy}`).toEqual({
    x: before.x + left,
    y: before.y + top,
    width: before.width - left + right,
    height: before.height - top + bottom,
  })
  return after
}

/** The visible panel (the view minus its shadow margin) lies in the window, below the toolbar. */
function expectInside(chat: Bounds, content: Size) {
  expect(chat.x + SHADOW).toBeGreaterThanOrEqual(0)
  expect(chat.y + SHADOW).toBeGreaterThanOrEqual(TOOLBAR_HEIGHT)
  expect(chat.x + chat.width - SHADOW).toBeLessThanOrEqual(content.width)
  expect(chat.y + chat.height - SHADOW).toBeLessThanOrEqual(content.height)
}

const right = (chat: Bounds) => chat.x + chat.width
const bottom = (chat: Bounds) => chat.y + chat.height

/**
 * How far the visible panel (or the pill, or the bubble) is from each edge of the canvas,
 * which the preview fills.
 */
function gaps({ chat, preview }: Layout) {
  return {
    left: chat.x + SHADOW - preview.x,
    top: chat.y + SHADOW - preview.y,
    right: right(preview) - (right(chat) - SHADOW),
    bottom: bottom(preview) - (bottom(chat) - SHADOW),
  }
}

/** Runs in main: resizes the window. */
function setContentSize({ BrowserWindow }: ElectronModule, size: Size) {
  BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
}

/** The window at `size`, laid out again once the canvas (which the preview fills) followed. */
const resizedTo = (size: Size) => (layout: Layout) =>
  layout.content.width === size.width &&
  layout.content.height === size.height &&
  layout.preview.width === size.width

test("a new window's chat panel starts at the bottom-right and stays in its corner", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await session.expandChat()

  // In the canvas's bottom-right corner, where pages tend to have least, at the usual margin.
  const start = await layoutWhere(session, 'the floating chat panel', (chat) => chat.width > 0)
  const bottomRight = { right: PANEL_MARGIN, bottom: PANEL_MARGIN }
  expect(gaps(start)).toMatchObject(bottomRight)
  await session.shot('panel-bottom-right')
  // Smaller, so it fits above the logs in a short window; its bottom-right corner stays.
  expect(gaps(await resizeFrom(session, start.chat, 'top-left', 40, 120))).toMatchObject(
    bottomRight,
  )

  // As the window and the canvas resize, it keeps to that corner. The window's shortest
  // height, so with the logs open the canvas is shorter than the panel's minimum (as on CI).
  const smaller = {
    width: Math.max(960, start.content.width - 160),
    height: 640,
  }
  await session.app.evaluate(setContentSize, smaller)
  const shrunk = await layoutWhen(session, 'the smaller window', resizedTo(smaller))
  expect(gaps(shrunk)).toMatchObject(bottomRight)
  await session.chrome.evaluate(() => window.gui.showLogs())
  const logs = await layoutWhen(
    session,
    'the canvas above the logs',
    ({ preview }) => preview.height < shrunk.preview.height,
  )
  expect(gaps(logs)).toMatchObject(bottomRight)
  await session.shot('panel-above-logs')
  await session.chrome.evaluate(() => window.gui.setDrawerOpen(false))
  const closed = await layoutWhen(
    session,
    'the canvas without the logs',
    ({ preview }) => preview.height === shrunk.preview.height,
  )

  // Dropped near the top-left, it springs into that corner (at the usual margin) and keeps
  // to it from then on, and so does the pill; new windows start there too.
  const before = gaps(closed)
  const topLeft = { left: PANEL_MARGIN, top: PANEL_MARGIN }
  await session.chat.evaluate(
    ({ dx, dy }) => {
      window.gui.dragChat(dx, dy)
      window.gui.endDragChat()
    },
    { dx: 40 - before.left, dy: 30 - before.top },
  )
  const dragged = await layoutWhen(session, 'the panel in the top-left corner', (layout) => {
    const { left, top } = gaps(layout)
    return left === topLeft.left && top === topLeft.top
  })
  await waitFor(() => {
    const { chatCorner } = savedPrefs(session)
    return chatCorner?.x === 'left' && chatCorner.y === 'top'
  }, 'the corner in prefs.json')
  const larger = { width: start.content.width, height: start.content.height }
  await session.app.evaluate(setContentSize, larger)
  const grown = await layoutWhen(session, 'the larger window', resizedTo(larger))
  expect(gaps(grown)).toMatchObject(topLeft)
  expect(grown.chat.width).toBe(dragged.chat.width)
  await session.chat.evaluate(() => window.gui.setMinimized(true))
  const pill = await layoutWhere(session, 'the pill', (chat) => chat.height < dragged.chat.height)
  expect(gaps(pill)).toMatchObject(topLeft)

  // The bubble, while picking, is in that corner too.
  await session.chrome.evaluate(() => window.gui.toggleSelect())
  const bubble = await layoutWhere(session, 'the bubble', (chat) => chat.width < pill.chat.width)
  expect(gaps(bubble)).toMatchObject(topLeft)
})

test('the chat panel resizes from its edges and corners and remembers the size', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await session.expandChat()

  const first = await layoutWhere(session, 'the floating chat panel', (chat) => chat.width > 0)
  expect(first.chat.width - SHADOW * 2).toBe(360)
  // Smaller first, so growing has room even when the window is short (CI's display).
  const small = (await resizeFrom(session, first.chat, 'bottom-left', 20, -120)).chat

  // In the middle of the window, so every edge has room to move either way. Held there mid-drag:
  // letting go would spring it into a corner.
  const { content } = first
  const middle = {
    x: Math.round((content.width - small.width) / 2),
    y: Math.round((TOOLBAR_HEIGHT + content.height - small.height) / 2),
  }
  await session.chat.evaluate(({ dx, dy }) => window.gui.dragChat(dx, dy), {
    dx: middle.x - small.x,
    dy: middle.y - small.y,
  })
  let panel = (
    await layoutWhere(
      session,
      'the panel in the middle',
      (chat) => chat.x === middle.x && chat.y === middle.y,
    )
  ).chat

  // From every corner and edge, outward and inward: the dragged edges follow the pointer,
  // the opposite ones stay put.
  const drags: [PanelEdge, number, number][] = [
    ['bottom-left', -100, 40],
    ['top-left', -16, -16],
    ['top-right', 16, -16],
    ['bottom-right', 16, 16],
    ['bottom-left', -16, 16],
    ['top', 0, -10],
    ['right', 10, 0],
    ['bottom', 0, 10],
    ['left', -10, 0],
    ['top-right', -24, 24],
    ['bottom-left', 24, -24],
  ]
  for (const [edge, dx, dy] of drags) {
    panel = (await resizeFrom(session, panel, edge, dx, dy)).chat
  }
  const size = { width: panel.width - SHADOW * 2, height: panel.height - SHADOW * 2 }
  await waitFor(() => {
    const { chatSize } = savedPrefs(session)
    return chatSize?.width === size.width && chatSize.height === size.height
  }, 'the floating size in prefs.json')

  // However far the pointer goes, the panel stops at the window's edges and below the
  // toolbar, and the opposite corner stays put.
  await resize(session, 'top-left', -5000, -5000)
  const topLeft = await layoutWhere(
    session,
    'the panel at its largest toward the top-left',
    (chat) => chat.width > panel.width && chat.height > panel.height,
  )
  expectInside(topLeft.chat, topLeft.content)
  expect(right(topLeft.chat)).toBe(right(panel))
  expect(bottom(topLeft.chat)).toBe(bottom(panel))
  await resize(session, 'bottom-right', 5000, 5000)
  const bottomRight = await layoutWhere(
    session,
    'the panel at its largest toward the bottom-right',
    (chat) => chat.width > topLeft.chat.width && chat.height > topLeft.chat.height,
  )
  expectInside(bottomRight.chat, bottomRight.content)
  expect(bottomRight.chat.x).toBe(topLeft.chat.x)
  expect(bottomRight.chat.y).toBe(topLeft.chat.y)

  // The sidebar: its right edge sets the column's width and the preview gets the rest.
  await session.chat.evaluate(() => window.gui.toggleDock())
  // Down the window's left side (once it has slid in), the preview beside it.
  const docked = await layoutWhen(
    session,
    'the sidebar',
    ({ chat, preview, content }) =>
      chat.width === 380 && chat.x === 0 && chat.height === content.height && preview.x >= 380,
  )
  await resize(session, 'right', 100, 0)
  // The chrome makes room after it, so the preview follows a moment later.
  const wider = await layoutWhen(
    session,
    'the wider sidebar',
    ({ chat, preview }) => chat.width === 480 && preview.x >= 480,
  )
  expect(wider.chat.x).toBe(docked.chat.x)
  await waitFor(() => savedPrefs(session).chatSidebarWidth === 480, 'the width in prefs.json')

  // Only the right edge: the others leave the column alone (these arrive in order).
  await resize(session, 'top-left', -100, -100)
  await resize(session, 'left', -30, 0)
  await resize(session, 'right', 50, 0)
  await layoutWhere(session, 'the sidebar resized only from its right edge', (chat) => {
    return chat.width === 530
  })

  // At most 60% of the window.
  await resize(session, 'right', 5000, 0)
  const widest = await layoutWhere(session, 'the widest sidebar', (chat) => chat.width > 530)
  expect(widest.chat.width).toBeLessThanOrEqual(Math.ceil(widest.content.width * 0.6))
  expect(widest.preview.width).toBeGreaterThan(0)
})
