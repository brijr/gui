import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ImageAttachment } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GratSession } from './helpers/session'
import { expect, test } from './helpers/test'

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** Transparent margin around the floating chat panel (SHADOW in window.ts). */
const SHADOW = 18
const PNG_SIGNATURE = '89504e470d0a1a0a'

interface Size {
  width: number
  height: number
}

/** State the main-process stubs below keep on `globalThis`. */
interface StubStore {
  /** Label of the screenshot menu item to choose next; any other label dismisses the menu */
  gratMenuChoice?: string | null
  gratMenuStubbed?: boolean
  gratClipboard?: (Size & { types: string[]; signature: string })[]
  gratSaveDefault?: string | null
}

/**
 * Runs in main: answers the next screenshot menu with `label` instead of showing it. The
 * real menu is built from the real template; only `popup`, which no test can click, is
 * replaced. Like Electron, it runs the chosen item's click before the close callback.
 */
function answerScreenshotMenu({ Menu }: ElectronModule, label: string) {
  const store = globalThis as unknown as StubStore
  store.gratMenuChoice = label
  if (store.gratMenuStubbed) return
  store.gratMenuStubbed = true
  const build = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = (template) => {
    const menu = build(template)
    const choice = store.gratMenuChoice
    if (!choice || !menu.items.some((item) => item.label === 'Copy Screenshot')) return menu
    menu.popup = (options) => {
      store.gratMenuChoice = null
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
  store.gratClipboard = []
  clipboard.write = async (items) => {
    for (const item of items) {
      const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer())
      store.gratClipboard?.push({
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
    store.gratSaveDefault = options?.defaultPath ?? null
    return Promise.resolve({ canceled: false, filePath })
  }) as typeof dialog.showSaveDialog
}

function stubs(session: GratSession) {
  return session.app.evaluate(() => {
    const { gratClipboard = [], gratSaveDefault = null } = globalThis as unknown as StubStore
    return { clipboard: gratClipboard, saveDefault: gratSaveDefault }
  })
}

/** The toolbar's button, with the menu answered by `label`. */
async function takeScreenshot(session: GratSession, label: string) {
  await session.app.evaluate(answerScreenshotMenu, label)
  return session.chrome.evaluate(() => window.grat.takeScreenshot())
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
// answerScreenshotMenu) and goes through the real path: window.grat.takeScreenshot() →
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
    const store = window as unknown as { gratAttached?: ImageAttachment[] }
    store.gratAttached = []
    window.grat.onChatAttach((image) => store.gratAttached?.push(image))
  })
  expect(await takeScreenshot(session, 'Attach to Chat')).toBe('attached')
  const attached = await waitFor(
    () =>
      session.chat.evaluate(() => {
        const store = window as unknown as { gratAttached?: ImageAttachment[] }
        return store.gratAttached?.[0] ?? null
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
  await session.chat.evaluate(() => window.grat.cancel())
  const { turn } = await session.waitForTurn(0, 30_000)
  expect(turn.attachments).toEqual([{ name: attached.name, thumbnail: attached.thumbnail }])
})

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Runs in main: the chat and preview views' bounds and the window's content size. */
function chatLayout({ BrowserWindow, WebContentsView }: ElectronModule) {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const views = win.contentView.children.filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const chat = views.find((view) => view.webContents.getURL().endsWith('/chat.html'))
  const preview = views.find((view) => /^https?:\/\//.test(view.webContents.getURL()))
  if (!chat?.getVisible() || !preview) return null
  const [width = 0, height = 0] = win.getContentSize()
  return { chat: chat.getBounds(), preview: preview.getBounds(), content: { width, height } }
}

/** Waits for the chat view's bounds to satisfy `check`. */
function layoutWhere(
  session: GratSession,
  label: string,
  check: (chat: Bounds) => boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof chatLayout>>>> {
  return waitFor(async () => {
    const layout = await session.app.evaluate(chatLayout)
    return layout && check(layout.chat) ? layout : null
  }, label)
}

function savedPrefs(session: GratSession) {
  const file = join(session.fixture.userData, 'prefs.json')
  return JSON.parse(readFileSync(file, 'utf8')) as {
    chatSize?: Size
    chatDockWidth?: number
  }
}

function resize(session: GratSession, dx: number, dy: number) {
  return session.chat.evaluate(
    ({ dx, dy }) => {
      window.grat.resizeChat(dx, dy)
      window.grat.endResizeChat()
    },
    { dx, dy },
  )
}

/** The visible panel (the view minus its shadow margin) lies inside the window. */
function expectInside(chat: Bounds, content: Size) {
  expect(chat.x + SHADOW).toBeGreaterThanOrEqual(0)
  expect(chat.y + SHADOW).toBeGreaterThanOrEqual(0)
  expect(chat.x + chat.width - SHADOW).toBeLessThanOrEqual(content.width)
  expect(chat.y + chat.height - SHADOW).toBeLessThanOrEqual(content.height)
}

test('the chat panel resizes from its edges and remembers the size', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()

  // Floating: the left edge widens it, the bottom edge lengthens it; the top-right stays put.
  const before = await layoutWhere(session, 'the floating chat panel', (chat) => chat.width > 0)
  expect(before.chat.width - SHADOW * 2).toBe(400)
  await resize(session, -100, 80)
  const after = await layoutWhere(
    session,
    'the resized panel',
    (chat) => chat.width !== before.chat.width,
  )
  expect(after.chat.width).toBe(before.chat.width + 100)
  expect(after.chat.height).toBe(before.chat.height + 80)
  expect(after.chat.x + after.chat.width).toBe(before.chat.x + before.chat.width)
  expect(after.chat.y).toBe(before.chat.y)
  expectInside(after.chat, after.content)
  const panel = { width: after.chat.width - SHADOW * 2, height: after.chat.height - SHADOW * 2 }
  await waitFor(() => {
    const { chatSize } = savedPrefs(session)
    return chatSize?.width === panel.width && chatSize.height === panel.height
  }, 'the floating size in prefs.json')

  // However far the pointer goes, the panel stops at the window's edges.
  await resize(session, -5000, 5000)
  const huge = await layoutWhere(
    session,
    'the panel at its largest',
    (chat) => chat.width > after.chat.width,
  )
  expectInside(huge.chat, huge.content)
  expect(huge.chat.x + huge.chat.width).toBe(before.chat.x + before.chat.width)
  expect(huge.chat.y).toBe(before.chat.y)

  // Docked: the left edge sets the column's width and the preview gets the rest.
  await session.chat.evaluate(() => window.grat.toggleDock())
  const docked = await layoutWhere(session, 'the docked panel', (chat) => chat.width === 400)
  await resize(session, -100, 0)
  const wider = await layoutWhere(session, 'the wider docked panel', (chat) => chat.width === 500)
  expect(wider.chat.x + wider.chat.width).toBe(docked.chat.x + docked.chat.width)
  expect(wider.preview.x + wider.preview.width).toBeLessThanOrEqual(wider.chat.x)
  await waitFor(() => savedPrefs(session).chatDockWidth === 500, 'the docked width in prefs.json')

  // At most 60% of the canvas.
  await resize(session, -5000, 0)
  const widest = await layoutWhere(session, 'the widest docked panel', (chat) => chat.width > 500)
  expect(widest.chat.width).toBeLessThanOrEqual(Math.ceil(widest.content.width * 0.6))
  expect(widest.preview.width).toBeGreaterThan(0)
})
