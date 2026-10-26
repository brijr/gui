import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLBAR_HEIGHT, TRAFFIC_LIGHTS } from '../src/shared/layout'
import type { Rect } from '../src/shared/types'
import { waitFor } from './helpers/env'
import { chooseFromChatMenu } from './helpers/menus'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The chat as the window's left sidebar (where it starts), ⌘B and ⌘L, and popping it out
// into a window of its own and back.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

interface Layout {
  windows: number
  content: { width: number; height: number }
  /** The chat's view and the window it's in: 0 for the project's, 1 for its own */
  chat: { bounds: Rect; visible: boolean; window: number } | null
  preview: Rect | null
  lights: { x: number; y: number } | null
  /** The preview mid-morph, resizing on its way (preview-morph.ts) */
  morphing: boolean
}

/** Runs in main: where the chat and the preview are, across the app's windows. */
function layout({ BrowserWindow, WebContentsView }: ElectronModule): Layout {
  const wins = BrowserWindow.getAllWindows()
  // The project's window first: the one with the preview in it.
  const views = (win: Electron.BrowserWindow) =>
    win.contentView.children.filter(
      (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
    )
  const isChat = (view: InstanceType<typeof WebContentsView>) =>
    view.webContents.getURL().endsWith('/chat.html')
  const isPreview = (view: InstanceType<typeof WebContentsView>) =>
    /^https?:\/\//.test(view.webContents.getURL())
  const main = wins.find((win) => views(win).some(isPreview)) ?? wins[0]
  const own = wins.find((win) => win !== main && views(win).some(isChat))
  const [width = 0, height = 0] = main?.getContentSize() ?? []
  const inMain = main ? views(main).find(isChat) : undefined
  const inOwn = own ? views(own).find(isChat) : undefined
  const chatView = inOwn ?? inMain
  return {
    windows: wins.filter((win) => win.isVisible()).length,
    content: { width, height },
    chat: chatView
      ? { bounds: chatView.getBounds(), visible: chatView.getVisible(), window: inOwn ? 1 : 0 }
      : null,
    preview: main ? (views(main).find(isPreview)?.getBounds() ?? null) : null,
    lights: main?.getWindowButtonPosition() ?? null,
    morphing: ((globalThis as { guiMorphing?: Set<number> }).guiMorphing?.size ?? 0) > 0,
  }
}

function layoutWhen(session: GuiSession, label: string, check: (layout: Layout) => boolean) {
  return waitFor(async () => {
    const now = await session.app.evaluate(layout)
    // Mid-morph the preview isn't where it's going yet.
    return now.preview && !now.morphing && check(now) ? now : null
  }, label)
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

const savedPrefs = (session: GuiSession) =>
  JSON.parse(readFileSync(join(session.fixture.userData, 'prefs.json'), 'utf8')) as {
    chatSidebarWidth?: number
  }

const SIDEBAR_WIDTH = 380

test('the chat starts as the left sidebar, top to bottom, and ⌘B hides and shows it', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: { chatSidebar: true } })
  await session.waitForPreview()

  // Down the window's left side, the traffic lights in its header; the chrome starts after it.
  const open = await layoutWhen(
    session,
    'the sidebar',
    ({ chat }) => chat?.visible === true && chat.bounds.width === SIDEBAR_WIDTH,
  )
  expect(open.chat?.bounds).toEqual({
    x: 0,
    y: 0,
    width: SIDEBAR_WIDTH,
    height: open.content.height,
  })
  expect(open.preview?.x).toBe(SIDEBAR_WIDTH)
  expect(open.preview?.y).toBeGreaterThanOrEqual(TOOLBAR_HEIGHT)
  expect(open.lights).toEqual(TRAFFIC_LIGHTS)
  expect((await session.state()).sidebarWidth).toBe(SIDEBAR_WIDTH)
  const meta = (await session.chatSnapshot()).meta
  expect(meta).toMatchObject({ docked: true, trafficLights: true, popped: false })
  // The header is the window's title bar beside the toolbar: as tall, and leaving the lights room.
  const header = session.chat.locator('[data-chat-panel] > header.drag')
  await expect(header).toHaveCSS('height', `${TOOLBAR_HEIGHT}px`)
  await session.shot('sidebar')

  // ⌘B: gone, and the chrome and preview take the whole width.
  await clickMenu(session, 'Show or Hide Chat')
  const hidden = await layoutWhen(
    session,
    'the sidebar hidden',
    ({ chat, preview }) => !chat?.visible && preview?.x === 0,
  )
  expect(hidden.preview?.x).toBe(0)
  expect((await session.state()).sidebarWidth).toBe(0)

  // ⌘L brings it back (with the cursor in the message box, when Gui is the active app).
  await clickMenu(session, 'Focus Message Box')
  await layoutWhen(
    session,
    'the sidebar back',
    ({ chat, preview }) => chat?.visible === true && preview?.x === SIDEBAR_WIDTH,
  )
  expect((await session.state()).sidebarWidth).toBe(SIDEBAR_WIDTH)

  // ⌘L again doesn't hide it; ⌘B does.
  await clickMenu(session, 'Focus Message Box')
  expect((await session.state()).chatVisible).toBe(true)
  await clickMenu(session, 'Show or Hide Chat')
  await layoutWhen(session, 'hidden by ⌘B', ({ chat }) => !chat?.visible)
  await clickMenu(session, 'Show or Hide Chat')
  await layoutWhen(session, 'shown by ⌘B', ({ chat }) => chat?.visible === true)

  // Its right edge resizes it, and the width is remembered.
  await session.chat.evaluate(() => {
    window.gui.resizeChat('right', 60, 0)
    window.gui.endResizeChat()
  })
  const wider = await layoutWhen(
    session,
    'the wider sidebar',
    ({ chat, preview }) =>
      chat?.bounds.width === SIDEBAR_WIDTH + 60 && preview?.x === SIDEBAR_WIDTH + 60,
  )
  expect(wider.preview?.x).toBe(SIDEBAR_WIDTH + 60)
  await waitFor(
    () => savedPrefs(session).chatSidebarWidth === SIDEBAR_WIDTH + 60,
    'the width saved',
  )

  // Floating instead: the chrome takes the width back and the lights return to the toolbar.
  await session.chat.evaluate(() => window.gui.toggleDock())
  const floating = await layoutWhen(
    session,
    'the floating panel',
    ({ chat, preview }) => chat?.visible === true && chat.bounds.y > 0 && preview?.x === 0,
  )
  expect(floating.preview?.x).toBe(0)
  expect((await session.chatSnapshot()).meta).toMatchObject({ docked: false, trafficLights: false })
})

test('the chat pops out into a window of its own and comes back when that closes', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: { chatSidebar: true } })
  await session.waitForPreview()
  await layoutWhen(session, 'the sidebar', ({ chat }) => chat?.visible === true)
  await session.chat.getByRole('textbox', { name: /^Message / }).fill('Keep this draft')

  // Out: its own window, which it fills; the preview takes the sidebar's room.
  await chooseFromChatMenu(session.app, session.chat, 'Pop Out Chat')
  const out = await layoutWhen(
    session,
    'the chat in its own window',
    ({ chat, windows, preview }) => chat?.window === 1 && windows === 2 && preview?.x === 0,
  )
  expect(out.chat?.bounds.x).toBe(0)
  expect(out.chat?.bounds.y).toBe(0)
  expect(out.preview?.x).toBe(0)
  expect((await session.state()).sidebarWidth).toBe(0)
  expect((await session.chatSnapshot()).meta).toMatchObject({ popped: true, trafficLights: true })
  // The same page: the draft came along.
  await expect(session.chat.getByRole('textbox', { name: /^Message / })).toHaveValue(
    'Keep this draft',
  )
  await expect(session.chat.getByRole('button', { name: 'Show as sidebar' })).toHaveCount(0)
  await session.shot('popped-out')

  // ⌘B doesn't hide it while it's out.
  await clickMenu(session, 'Show or Hide Chat')
  expect((await session.app.evaluate(layout)).chat?.window).toBe(1)

  // Closing its window puts it back as the sidebar it was.
  await session.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows()
    wins.find((win) => win.getTitle().endsWith('— Chat'))?.close()
  })
  const back = await layoutWhen(
    session,
    'the sidebar back',
    ({ chat, windows, preview }) =>
      chat?.window === 0 && chat.visible && windows === 1 && preview?.x === SIDEBAR_WIDTH,
  )
  expect(back.chat?.bounds.x).toBe(0)
  expect(back.preview?.x).toBe(SIDEBAR_WIDTH)
  expect((await session.chatSnapshot()).meta.popped).toBe(false)

  // ⌥⌘L out and back from the menu, and Back to window from its header.
  await clickMenu(session, 'Pop Out Chat')
  await layoutWhen(session, 'out by ⌥⌘L', ({ chat }) => chat?.window === 1)
  await session.chat.getByRole('button', { name: 'Back to window', exact: true }).click()
  await layoutWhen(session, 'back from the header', ({ chat }) => chat?.window === 0)
})
