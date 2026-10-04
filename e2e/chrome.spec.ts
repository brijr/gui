import { readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { agentName } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import { devServerPids, killAll } from './helpers/processes'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The window's chrome around the preview: the toolbar (the project menu, then for a project
// its navigation, the address led by the dev server's status, viewport, screenshot, Select
// and chat), the canvas's states, the drawer's dev server output, and the chat's ⌘L.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** State the main-process stub below keeps on `globalThis`. */
interface MenuStore {
  /** Label of the dev-server menu item to choose next */
  guiMenuChoice?: string | null
  guiMenuStubbed?: boolean
  /** The items the dev-server menu offered last time */
  guiMenuItems?: string[]
}

/**
 * Runs in main: answers the next dev-server menu with `label` instead of showing it, and
 * records what it offered. The menu is built from the real template; only `popup`, which no
 * test can click, is replaced.
 */
function answerDevServerMenu({ Menu }: ElectronModule, label: string) {
  const store = globalThis as unknown as MenuStore
  store.guiMenuChoice = label
  if (store.guiMenuStubbed) return
  store.guiMenuStubbed = true
  const build = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = (template) => {
    const menu = build(template)
    const choice = store.guiMenuChoice
    if (!choice || !menu.items.some((item) => item.label === 'Stop dev server')) return menu
    menu.popup = (options) => {
      store.guiMenuChoice = null
      store.guiMenuItems = menu.items
        .filter((item) => item.type !== 'separator')
        .map((i) => i.label)
      menu.items.find((item) => item.label === choice && item.enabled)?.click()
      options?.callback?.()
    }
    return menu
  }
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

/** A loopback port nothing listens on (until the test does). */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const toolbar = (session: GuiSession) => session.chrome.getByRole('banner')
const serverStatus = (session: GuiSession) =>
  toolbar(session).getByRole('button', { name: /^Dev server: / })
const address = (session: GuiSession) => toolbar(session).getByLabel('App address')
/** The drawer's Dev server tab, shown; there only while the drawer is open. */
const logsTab = (session: GuiSession) =>
  session.chrome.getByRole('tab', { name: 'Dev server', selected: true })
/** The drawer is open on the dev server's output. */
const logsOpen = async (session: GuiSession) => {
  const { drawer } = await session.state()
  return drawer.open && drawer.tab === 'server'
}
const drawerOpen = async (session: GuiSession) => (await session.state()).drawer.open

test('the start tab shows only the project menu; a project fills the toolbar, without the agent menu', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root } = session.fixture
  // A dev script that takes a moment, so the starting state can be seen.
  const pkg = join(root, 'package.json')
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"dev": "vite"', '"dev": "sleep 4 && vite"'))

  // No project: only the project menu, nothing that would act on one.
  await expect(toolbar(session).getByRole('button')).toHaveText(['Gui'])
  await expect(address(session)).toHaveCount(0)
  await expect(toolbar(session).getByRole('group', { name: 'Viewport' })).toHaveCount(0)
  await session.shot('start-tab')

  await session.chrome.evaluate((path) => window.gui.openRecent(path), root)
  // Starting: the status says so, and the field shows no address it doesn't have.
  await expect(serverStatus(session)).toHaveAccessibleName('Dev server: Starting…')
  await expect(address(session)).toHaveValue('')
  await expect(address(session)).toHaveAttribute('placeholder', 'Starting…')
  await session.shot('starting')

  const state = await session.waitForPreview()
  await expect(serverStatus(session)).toHaveAccessibleName('Dev server: Running')
  await expect(address(session)).toHaveValue(state.preview.url ?? '')
  const bar = toolbar(session)
  await expect(bar.getByRole('button', { name: 'gui-e2e-vite' })).toBeVisible()
  for (const name of ['Back', 'Forward', 'Reload preview', 'Screenshot', 'Toggle chat']) {
    await expect(bar.getByRole('button', { name, exact: true })).toBeVisible()
  }
  // Each names its shortcut in its tooltip, and to assistive tech.
  const chat = bar.getByRole('button', { name: 'Toggle chat', exact: true })
  await expect(chat).toHaveAttribute('title', 'Toggle chat (⌘L)')
  await expect(chat).toHaveAttribute('aria-keyshortcuts', 'Meta+L')
  await expect(bar.getByRole('group', { name: 'Viewport' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Select', exact: true })).toBeVisible()
  // The agent is switched from the chat's header (and the start screen), not the toolbar.
  await expect(bar.getByRole('button', { name: agentName(state.agentId) })).toHaveCount(0)
  await session.shot('running')
})

test('logs open in the drawer from the status menu and ⌘J; a crash shows a bar instead', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const { root } = session.fixture

  // Closed, nothing of the logs shows under the canvas.
  expect(await drawerOpen(session)).toBe(false)
  await expect(logsTab(session)).toHaveCount(0)

  // The address bar's status opens the dev-server menu, whose "Show logs" opens the drawer on
  // the dev server's output.
  await session.app.evaluate(answerDevServerMenu, 'Show logs')
  await serverStatus(session).click()
  await waitFor(() => logsOpen(session), 'the logs to open from the status menu')
  await expect(logsTab(session)).toBeVisible()
  const offered = await session.app.evaluate(
    () => (globalThis as unknown as MenuStore).guiMenuItems,
  )
  expect(offered).toEqual(['Restart dev server', 'Stop dev server', 'Show logs', 'Open in browser'])
  await session.shot('logs')
  await session.chrome.getByRole('button', { name: 'Hide terminal', exact: true }).click()
  await waitFor(async () => !(await drawerOpen(session)), 'the drawer to close')
  await expect(logsTab(session)).toHaveCount(0)

  // View → Toggle Terminal (⌘J) opens it again on the tab it showed, the logs, without
  // starting a shell, and closes it.
  await clickMenu(session, 'Toggle Terminal')
  await waitFor(() => logsOpen(session), 'the logs to open from the menu')
  expect((await session.state()).drawer.terminals).toEqual([])
  await clickMenu(session, 'Toggle Terminal')
  await waitFor(async () => !(await drawerOpen(session)), 'the drawer to close from the menu')

  // The dev server crashes: its last page stays, the status turns red, and instead of raw
  // output a bar under the canvas offers the logs and a restart.
  killAll(devServerPids(root))
  const crashed = await waitFor(async () => {
    const state = await session.state()
    return state.devServer.status === 'exited' ? state : null
  }, 'the dev server to exit')
  expect(crashed.devServer.exitCode).not.toBe(0)
  expect(crashed.preview.visible).toBe(true)
  expect(crashed.drawer.open).toBe(false)
  await expect(serverStatus(session)).toHaveAccessibleName('Dev server: Stopped with an error')
  const crashBar = session.chrome.getByRole('alert')
  await expect(crashBar).toContainText('Your app stopped with an error')
  await session.shot('crash-bar')

  await crashBar.getByRole('button', { name: 'Show logs' }).click()
  await waitFor(() => logsOpen(session), 'the logs to open from the crash bar')
  await expect(crashBar).toHaveCount(0)
  const drawer = session.chrome.getByRole('region', { name: 'Terminal' })
  await expect(drawer).toContainText('Stopped with an error')
  await session.shot('crash-logs')

  await drawer.getByRole('button', { name: 'Restart' }).click()
  await session.waitForPreview()
  await expect(serverStatus(session)).toHaveAccessibleName('Dev server: Running')
  await expect(drawer).not.toContainText('Stopped with an error')
})

test('a preview that fails to load says why, and Try again loads it once it can', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const running = await session.waitForPreview()
  const port = await freePort()
  const url = `http://127.0.0.1:${port}/`

  await session.chrome.evaluate((target) => window.gui.navigate(target), url)
  const failed = await waitFor(async () => {
    const state = await session.state()
    return state.preview.error ? state : null
  }, 'the load to fail')
  expect(failed.preview.error).toContain('ERR_CONNECTION_REFUSED')
  expect(failed.preview.visible).toBe(false)
  // Chromium's error page fires dom-ready like any page; the failure must outlast it.
  await sleep(1_500)
  expect((await session.state()).preview).toMatchObject({ visible: false, url })
  await expect(session.chrome.getByText("Your app couldn't load")).toBeVisible()
  await expect(address(session)).toHaveValue(url)
  await session.shot('load-failed')

  // Once something answers there, Try again loads it.
  const server = createHttpServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<h1>Back again</h1>')
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  try {
    await session.chrome.getByRole('button', { name: 'Try again' }).click()
    const loaded = await waitFor(async () => {
      const state = await session.state()
      return state.preview.visible && !state.preview.error ? state : null
    }, 'the page to load')
    expect(loaded.preview.url).toBe(url)
    await expect(session.chrome.getByText("Your app couldn't load")).toHaveCount(0)

    // And the app itself loads as before.
    const app = running.preview.url ?? ''
    await session.chrome.evaluate((target) => window.gui.navigate(target), app)
    await waitFor(async () => {
      const { preview } = await session.state()
      return preview.visible && preview.url === app
    }, 'the app to load again')
  } finally {
    server.close()
  }
})

test('⌘L shows the chat with the cursor in its message box, and from there hides it', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()

  // The View menu: the terminal on ⌘J, the chat on ⌘L, and no logs of their own.
  const toggles = await session.app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'View')
      ?.submenu?.items.filter((item) => item.label.startsWith('Toggle'))
      .map((item) => [item.label, item.accelerator]),
  )
  expect(toggles).toEqual([
    ['Toggle Chat', 'CmdOrCtrl+L'],
    ['Toggle Terminal', 'CmdOrCtrl+J'],
  ])

  // Where the keyboard is depends on Gui being the active app, as it is when the user presses
  // ⌘L; a script's Gui may be behind another app.
  await session.app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true })
    BrowserWindow.getAllWindows()[0]?.focus()
  })
  await waitFor(
    () =>
      session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused()),
    'the window to be focused',
  )

  const visible = async () => (await session.state()).chatVisible
  /** The chat panel has the keyboard, and in it the message box. */
  const inMessageBox = async () => {
    const focused = await session.app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .some((wc) => wc.getURL().endsWith('/chat.html') && wc.isFocused()),
    )
    const composer = await session.chat.evaluate(
      () => document.activeElement?.hasAttribute('data-composer') === true,
    )
    return focused && composer
  }

  // Hidden (with the toolbar's button): ⌘L shows it, with the cursor in the message box.
  await toolbar(session).getByRole('button', { name: 'Toggle chat', exact: true }).click()
  await waitFor(async () => !(await visible()), 'the chat to hide')
  await clickMenu(session, 'Toggle Chat')
  await waitFor(visible, 'the chat to show')
  await waitFor(inMessageBox, 'the cursor in the message box')

  // Shown, with the keyboard elsewhere: ⌘L brings it back to the message box.
  await session.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.focus(),
  )
  await address(session).focus()
  expect(await inMessageBox()).toBe(false)
  await clickMenu(session, 'Toggle Chat')
  await waitFor(inMessageBox, 'the cursor back in the message box')
  expect(await visible()).toBe(true)

  // From the message box, ⌘L hides the chat.
  await clickMenu(session, 'Toggle Chat')
  await waitFor(async () => !(await visible()), 'the chat to hide from the message box')
})
