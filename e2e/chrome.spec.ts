import { readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { agentName } from '../src/shared/types'
import { sleep, TAKES_FOCUS, takesFocus, waitFor } from './helpers/env'
import { devServerPids, killAll } from './helpers/processes'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The window's chrome around the preview: the toolbar (the project menu, then for a project
// its navigation, the address led by the dev server's status, viewport, screenshot, Select
// and chat), the canvas's states, the drawer's dev server output, and the chat's ⌘B and ⌘L.

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
    if (!choice || !menu.items.some((item) => item.label === 'Stop Dev Server')) return menu
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

/** What the window drew, one entry each time it changed (`recordFrames`). */
interface Frame {
  /** The bar under a page still on screen (drawer.tsx `StoppedBar`) */
  bar: boolean
  /** The "Your app stopped" card on the canvas */
  card: boolean
  /** The dimmed picture of the page */
  still: boolean
  /** The canvas's height, which the bar takes from */
  height: number
}

type Recorded = { guiFrames: Frame[]; guiBarInserted: boolean }

/**
 * In the window: notes what each frame shows, from now on, into `guiFrames` (a frame like the
 * one before isn't noted again), and in `guiBarInserted` whether the bar was put in the page
 * at all, drawn or not.
 */
function recordFrames() {
  const store = window as unknown as Recorded
  store.guiFrames = []
  store.guiBarInserted = false
  const barShown = () => document.body.textContent?.includes('Your app stopped with an error.')
  new MutationObserver(() => {
    if (barShown()) store.guiBarInserted = true
  }).observe(document.body, { childList: true, subtree: true, characterData: true })
  let last = ''
  const note = () => {
    const main = document.querySelector('main')
    const frame: Frame = {
      bar: !!barShown(),
      card: !!main?.textContent?.includes('Your app stopped'),
      still: !!document.querySelector('[data-preview-still]'),
      height: Math.round(main?.getBoundingClientRect().height ?? 0),
    }
    const key = JSON.stringify(frame)
    if (key !== last) store.guiFrames.push(frame)
    last = key
    requestAnimationFrame(note)
  }
  requestAnimationFrame(note)
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

test('preview history stops before the internal blank page and reload recovers a stranded preview', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const running = await session.waitForPreview()
  const first = running.preview.url ?? ''
  const back = toolbar(session).getByRole('button', { name: 'Back', exact: true })
  const forward = toolbar(session).getByRole('button', { name: 'Forward', exact: true })
  // Back and Forward are in the address field only while there's somewhere to go.
  await expect(back).toHaveCount(0)
  await expect(forward).toHaveCount(0)

  const second = new URL('/second', first).href
  await address(session).fill(second)
  await address(session).press('Enter')
  await expect(address(session)).toHaveValue(second)
  await expect(back).toBeEnabled()
  await back.click()
  await expect(address(session)).toHaveValue(first)
  await expect(back).toHaveCount(0)
  // A repeated Back request cannot enter Electron's initial about:blank entry.
  await session.chrome.evaluate(() => window.gui.back())
  const preview = await session.previewPage()
  await expect(preview).toHaveURL(first)
  await expect(forward).toBeEnabled()
  await forward.click()
  await expect(preview).toHaveURL(second)

  // Recreate a preview already stranded by the old Back behavior. Its last app address
  // remains in Gui's state, so the visible Reload action must restore that address.
  await session.app.evaluate(async ({ webContents }, url) => {
    const page = webContents.getAllWebContents().find((wc) => wc.getURL() === url)
    if (!page) throw new Error('The preview is missing')
    await page.loadURL('about:blank')
  }, second)
  await expect(preview).toHaveURL('about:blank')
  await expect(address(session)).toHaveValue(second)
  await toolbar(session).getByRole('button', { name: 'Reload preview', exact: true }).click()
  await expect(preview).toHaveURL(second)
  await expect(preview.getByRole('heading', { name: 'Gui Vite fixture' })).toBeVisible()
})

test('the start tab offers project actions; a project fills the toolbar, without the agent menu', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root } = session.fixture
  // A dev script that takes a moment, so the starting state can be seen.
  const pkg = join(root, 'package.json')
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"dev": "vite"', '"dev": "sleep 4 && vite"'))

  // Before opening a project, its actions live on the start screen.
  await expect(toolbar(session)).toHaveCount(0)
  await expect(
    session.chrome.getByRole('button', { name: 'Open project…', exact: true }),
  ).toBeVisible()
  await expect(address(session)).toHaveCount(0)
  await expect(toolbar(session).getByRole('button', { name: /^Viewport: / })).toHaveCount(0)
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
  for (const name of ['Reload preview', 'Screenshot', 'Hide chat']) {
    await expect(bar.getByRole('button', { name, exact: true })).toBeVisible()
  }
  // No history yet: no Back or Forward sitting there disabled.
  for (const name of ['Back', 'Forward']) {
    await expect(bar.getByRole('button', { name, exact: true })).toHaveCount(0)
  }
  // Each names its shortcut in its tooltip, and to assistive tech.
  // The chat shows, so its button says what a click does: hide it.
  const chat = bar.getByRole('button', { name: 'Hide chat', exact: true })
  await expect(chat).toHaveAttribute('title', 'Hide chat (⌘B)')
  await expect(chat).toHaveAttribute('aria-keyshortcuts', 'Meta+B')
  await expect(bar.getByRole('button', { name: 'Viewport: Desktop', exact: true })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Design mode', exact: true })).toBeVisible()
  // The agent is switched from the chat's header (and the start screen), not the toolbar.
  await expect(bar.getByRole('button', { name: agentName(state.agentId) })).toHaveCount(0)
  await session.shot('running')
})

test('a start command that exits cleanly before the app came up is a failed start, with a fix', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root } = session.fixture
  // Exits 0 without ever serving anything.
  const pkg = join(root, 'package.json')
  writeFileSync(
    pkg,
    readFileSync(pkg, 'utf8').replace('"dev": "vite"', '"dev": "echo Error: nothing to serve"'),
  )
  await session.chrome.evaluate((path) => window.gui.openRecent(path), root)
  const state = await waitFor(async () => {
    const state = await session.state()
    return state.devServer.status === 'exited' ? state : null
  }, 'the start command to exit')
  expect(state.devServer.exitCode).toBe(0)
  expect(state.devServer.cameUp).toBe(false)
  await expect(serverStatus(session)).toHaveAccessibleName('Dev server: Stopped with an error')
  const canvas = session.chrome.getByRole('main')
  await expect(canvas.getByText('Your app stopped', { exact: true })).toBeVisible()
  await expect(canvas).toContainText('nothing to serve')
  await expect(canvas).not.toContainText('without an error')
  await expect(canvas.getByRole('button', { name: /^Fix with / })).toBeVisible()
})

test('logs open in the drawer from the status menu and ⌘J; a crash dims the page under a card that offers them', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const { root } = session.fixture

  // Closed, nothing of the logs shows under the canvas.
  expect(await drawerOpen(session)).toBe(false)
  await expect(logsTab(session)).toHaveCount(0)

  // The address bar's status opens the dev-server menu, whose "Show Logs" opens the drawer on
  // the dev server's output.
  await session.app.evaluate(answerDevServerMenu, 'Show Logs')
  await serverStatus(session).click()
  await waitFor(() => logsOpen(session), 'the logs to open from the status menu')
  await expect(logsTab(session)).toBeVisible()
  const offered = await session.app.evaluate(
    () => (globalThis as unknown as MenuStore).guiMenuItems,
  )
  expect(offered).toEqual(['Restart Dev Server', 'Stop Dev Server', 'Show Logs', 'Open in Browser'])
  await session.shot('logs')
  await session.chrome.getByRole('button', { name: 'Hide terminal', exact: true }).click()
  await waitFor(async () => !(await drawerOpen(session)), 'the drawer to close')
  await expect(logsTab(session)).toHaveCount(0)

  // View → Show Terminal (⌘J) opens it again on the tab it showed, the logs, without
  // starting a shell, and Hide Terminal closes it.
  await clickMenu(session, 'Show Terminal')
  await waitFor(() => logsOpen(session), 'the logs to open from the menu')
  expect((await session.state()).drawer.terminals).toEqual([])
  await clickMenu(session, 'Hide Terminal')
  await waitFor(async () => !(await drawerOpen(session)), 'the drawer to close from the menu')

  // The dev server crashes: its last page stays, dimmed so it doesn't pass for live, the
  // status turns red, and instead of raw output a card over it says why, with the logs.
  // Every frame the window draws on the way is recorded: none shows the bar that goes under a
  // page still on screen, and the canvas keeps its size (no shift before the card).
  await session.chrome.evaluate(recordFrames)
  killAll(devServerPids(root))
  const crashed = await waitFor(async () => {
    const state = await session.state()
    return state.devServer.status === 'exited' && !state.preview.visible ? state : null
  }, 'the dev server to exit and its page to dim')
  expect(crashed.devServer.exitCode).not.toBe(0)
  expect(crashed.preview.still).toMatch(/^data:image\/jpeg;base64,/)
  expect(crashed.drawer.open).toBe(false)
  await expect(session.chrome.locator('[data-preview-still]')).toBeVisible()
  await expect(serverStatus(session)).toHaveAccessibleName('Dev server: Stopped with an error')
  const canvas = session.chrome.getByRole('main')
  await expect(canvas.getByText('Your app stopped', { exact: true })).toBeVisible()
  await expect(canvas).toContainText('terminated by signal SIGKILL')
  const { frames, barInserted } = await session.chrome.evaluate(() => {
    const { guiFrames, guiBarInserted } = window as unknown as Recorded
    return { frames: guiFrames, barInserted: guiBarInserted }
  })
  expect(barInserted).toBe(false)
  expect(frames.filter((frame) => frame.bar)).toEqual([])
  expect(new Set(frames.map((frame) => frame.height)).size).toBe(1)
  // The card comes with the picture, in the same frame.
  expect(frames.filter((frame) => frame.card !== frame.still)).toEqual([])
  // The card says it to a screen reader as it appears, without taking the keyboard; the bar
  // under a page that's still on screen isn't shown over it to say it twice.
  const alert = session.chrome.getByRole('alert')
  await expect(alert).toHaveCount(1)
  await expect(alert).toContainText('Your app stopped')
  await expect(alert).toContainText('terminated by signal SIGKILL')
  await expect(alert.getByRole('button')).toHaveCount(0)
  expect(await canvas.evaluate((main) => main.contains(document.activeElement))).toBe(false)
  await session.shot('crash-card')

  await canvas.getByRole('button', { name: 'Show logs' }).click()
  await waitFor(() => logsOpen(session), 'the logs to open from the crash card')
  await expect(canvas.getByRole('button', { name: 'Hide logs' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  const drawer = session.chrome.getByRole('region', { name: 'Terminal' })
  await expect(drawer).toContainText('Stopped with an error')
  await session.shot('crash-logs')

  await drawer.getByRole('button', { name: 'Restart' }).click()
  await session.waitForPreview()
  await expect(serverStatus(session)).toHaveAccessibleName('Dev server: Running')
  await expect(drawer).not.toContainText('Stopped with an error')
  await expect(session.chrome.locator('[data-preview-still]')).toHaveCount(0)
  await expect(canvas.getByText('Your app stopped', { exact: true })).toHaveCount(0)
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
  // Plain words in the card; Chromium's code stays behind Details.
  expect(failed.preview.error?.message).toContain('Nothing is answering at')
  expect(failed.preview.error?.detail).toContain('ERR_CONNECTION_REFUSED')
  expect(failed.preview.visible).toBe(false)
  // Chromium's error page fires dom-ready like any page; the failure must outlast it.
  await sleep(1_500)
  expect((await session.state()).preview).toMatchObject({ visible: false, url })
  await expect(session.chrome.getByText('Your app couldn’t load')).toBeVisible()
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
    await expect(session.chrome.getByText('Your app couldn’t load')).toHaveCount(0)

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

test('⌘B shows and hides the chat; ⌘L puts the cursor in its message box', async ({ launch }) => {
  test.skip(takesFocus, TAKES_FOCUS)
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()

  // The View menu: the terminal on ⌘J, the chat on ⌘B, and no logs of their own. Each says
  // what it will do: the chat is showing, the terminal isn't.
  const toggles = await session.app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'View')
      ?.submenu?.items.filter((item) => item.visible && /^(Show|Hide) /.test(item.label))
      .map((item) => [item.label, item.accelerator]),
  )
  expect(toggles).toEqual([
    ['Hide Chat', 'CmdOrCtrl+B'],
    ['Show Terminal', 'CmdOrCtrl+J'],
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
  await toolbar(session).getByRole('button', { name: 'Hide chat', exact: true }).click()
  await waitFor(async () => !(await visible()), 'the chat to hide')
  await clickMenu(session, 'Focus Message Box')
  await waitFor(visible, 'the chat to show')
  await waitFor(inMessageBox, 'the cursor in the message box')

  // Shown, with the keyboard elsewhere: ⌘L brings it back to the message box.
  await session.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.focus(),
  )
  await address(session).focus()
  expect(await inMessageBox()).toBe(false)
  await clickMenu(session, 'Focus Message Box')
  await waitFor(inMessageBox, 'the cursor back in the message box')
  expect(await visible()).toBe(true)

  // From the message box ⌘L leaves it be; ⌘B hides the chat, and shows it again.
  await clickMenu(session, 'Focus Message Box')
  expect(await visible()).toBe(true)
  await clickMenu(session, 'Hide Chat')
  await waitFor(async () => !(await visible()), 'the chat to hide')
  await clickMenu(session, 'Show Chat')
  await waitFor(visible, 'the chat to show again')
})
