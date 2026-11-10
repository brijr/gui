import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './helpers/test'

test('chat sidebar switches sides, resizes from its inner edge, and saves the choice', async ({
  launch,
}) => {
  const session = await launch({
    fixture: 'vite',
    prefs: { chatSidebar: true, chatSidebarSide: 'right' },
    reducedMotion: 'reduce',
  })
  await session.waitForPreview()
  await expect.poll(async () => (await session.state()).sidebarWidth).toBeGreaterThan(0)
  const bounds = () =>
    session.app.evaluate(({ BrowserWindow, WebContentsView }) => {
      const win = BrowserWindow.getAllWindows().find((win) => win.getTitle() !== 'Settings')
      if (!win) throw new Error('Missing project window')
      const chat = win.contentView.children.find(
        (view) =>
          view instanceof WebContentsView && view.webContents.getURL().endsWith('/chat.html'),
      )
      if (!chat) throw new Error('Missing chat view')
      const preview = win.contentView.children.find(
        (view) => view instanceof WebContentsView && /^https?:/.test(view.webContents.getURL()),
      )
      return {
        chat: chat.getBounds(),
        width: win.getContentSize()[0],
        preview: preview?.getBounds(),
        previewVisible: preview?.getVisible(),
      }
    })
  let layout = await bounds()
  expect(layout.chat.x + layout.chat.width).toBe(layout.width)
  expect((await session.chatSnapshot()).meta.trafficLights).toBe(false)
  await session.shot('sidebar-right', true)

  const before = (await session.state()).sidebarWidth
  await session.chrome.evaluate((width) => {
    document.documentElement.dataset.resizePatches = '0'
    window.gui.onState((state) => {
      if (state.sidebarWidth === width) return
      width = state.sidebarWidth
      const root = document.documentElement
      root.dataset.resizePatches = String(Number(root.dataset.resizePatches) + 1)
    })
  }, before)
  await session.chat.evaluate(() => {
    for (let i = 0; i < 20; i++) window.gui.resizeChat('left', -2, 0)
  })
  await expect.poll(async () => (await bounds()).chat.width).toBe(before + 40)
  expect((await session.state()).sidebarWidth).toBe(before)
  const patches = () =>
    session.chrome.evaluate(() => Number(document.documentElement.dataset.resizePatches))
  expect(await patches()).toBe(0)
  await session.chat.evaluate(() => window.gui.endResizeChat())
  await expect.poll(async () => (await session.state()).sidebarWidth).toBe(before + 40)
  await expect.poll(patches).toBe(1)
  console.log('[resize] 20 live width updates: 0 sidebar state patches during drag, 1 on release')
  layout = await bounds()
  expect(layout.chat.x + layout.chat.width).toBe(layout.width)

  await session.chrome.evaluate(() => window.gui.openSettings('chat'))
  await expect
    .poll(() =>
      session.app
        .context()
        .pages()
        .some((p) => p.url().endsWith('/settings.html')),
    )
    .toBe(true)
  const page = session.app
    .context()
    .pages()
    .find((p) => p.url().endsWith('/settings.html'))
  if (!page) throw new Error('Missing settings window')
  await page.getByRole('button', { name: 'Left', exact: true }).click()
  await expect.poll(async () => (await session.state()).sidebarSide).toBe('left')
  expect((await bounds()).chat.x).toBe(0)
  await expect.poll(async () => (await session.chatSnapshot()).meta.trafficLights).toBe(true)
  await page.screenshot({ path: 'test-results/chat-sidebar-settings.png' })
  await page.close()
  await expect(session.chrome.locator('[data-morph]')).toHaveCount(0)
  await expect
    .poll(async () => (await bounds()).preview?.x)
    .toBe((await session.state()).sidebarWidth)
  await expect.poll(async () => (await bounds()).previewVisible).toBe(true)
  await session.shot('sidebar-left', true)
  await session.chrome.evaluate(() => window.gui.openSettings('chat'))
  await expect
    .poll(() =>
      session.app
        .context()
        .pages()
        .some((p) => p.url().endsWith('/settings.html')),
    )
    .toBe(true)
  const reopened = session.app
    .context()
    .pages()
    .find((p) => p.url().endsWith('/settings.html'))
  if (!reopened) throw new Error('Missing reopened settings window')

  await reopened.getByRole('button', { name: 'Right', exact: true }).click()
  await expect.poll(async () => (await session.state()).sidebarSide).toBe('right')
  const profile = await session.app.evaluate(({ app }) => app.getPath('userData'))
  expect(JSON.parse(readFileSync(join(profile, 'prefs.json'), 'utf8')).chatSidebarSide).toBe(
    'right',
  )

  await reopened.close()
  await session.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((win) => win.getTitle() !== 'Settings')
    win?.setContentSize(960, 600)
  })
  await expect.poll(async () => (await bounds()).width).toBe(960)
  await expect(session.chrome.locator('[data-morph]')).toHaveCount(0)
  await session.shot('sidebar-right-small', true)
})

test("Settings' chat position moves the chat of a project that's open", async ({ launch }) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await session.waitForPreview()
  const docked = async () => (await session.chatSnapshot()).meta.docked
  const sidebar = async () => (await session.state()).sidebarWidth
  /** The chat's view in the project window, and the window's width. */
  const placed = () =>
    session.app.evaluate(({ BrowserWindow, WebContentsView }) => {
      const win = BrowserWindow.getAllWindows().find((win) => win.getTitle() !== 'Settings')
      const chat = win?.contentView.children.find(
        (view) =>
          view instanceof WebContentsView && view.webContents.getURL().endsWith('/chat.html'),
      )
      if (!win || !chat) throw new Error('Missing chat view')
      const morphing = (globalThis as { guiMorphing?: Set<number> }).guiMorphing?.size ?? 0
      return { ...chat.getBounds(), window: win.getContentSize()[0], morphing }
    })
  expect(await docked()).toBe(false)
  expect(await sidebar()).toBe(0)

  await session.chrome.evaluate(() => window.gui.openSettings('chat'))
  const opened = () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/settings.html'))
  await expect.poll(() => !!opened()).toBe(true)
  const settings = opened()
  if (!settings) throw new Error('Missing settings window')
  const pick = (position: 'Floating' | 'Left' | 'Right') =>
    settings.getByRole('button', { name: position, exact: true }).click()

  await pick('Right')
  await expect.poll(docked).toBe(true)
  // Reduce motion: the sidebar is simply there, with nothing morphing on the way.
  expect((await placed()).morphing).toBe(0)
  await expect.poll(sidebar).toBeGreaterThan(0)
  let view = await placed()
  expect(view.x + view.width).toBe(view.window)
  await pick('Floating')
  await expect.poll(docked).toBe(false)
  await expect.poll(sidebar).toBe(0)

  // Focus mode stays on, and the chat is docked once it ends.
  await session.chrome.evaluate(() => window.gui.setFocusMode(true))
  await expect.poll(async () => (await session.state()).focusMode).toBe(true)
  await pick('Left')
  await expect.poll(docked).toBe(true)
  expect((await session.state()).focusMode).toBe(true)
  await session.chrome.evaluate(() => window.gui.setFocusMode(false))
  await expect.poll(sidebar).toBeGreaterThan(0)
  expect((await placed()).x).toBe(0)

  // A hidden chat stays hidden.
  await session.chrome.evaluate(() => window.gui.toggleChat())
  await expect.poll(async () => (await session.state()).chatVisible).toBe(false)
  await pick('Floating')
  await expect.poll(docked).toBe(false)
  expect((await session.state()).chatVisible).toBe(false)
  await session.chrome.evaluate(() => window.gui.toggleChat())
  await expect.poll(async () => (await session.state()).chatVisible).toBe(true)

  // A project in a background tab is docked when its tab is shown again.
  const project = (await session.state()).activeTab
  await session.chrome.evaluate(() => window.gui.newTab())
  await expect.poll(async () => (await session.state()).activeTab).not.toBe(project)
  await pick('Right')
  await expect.poll(docked).toBe(true)
  await session.chrome.evaluate((id) => window.gui.selectTab(id), project)
  await expect.poll(sidebar).toBeGreaterThan(0)
  view = await placed()
  expect(view.x + view.width).toBe(view.window)
})
