import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { type AgentId, CUSTOM_AGENT_PREFIX, type TabInfo, type Turn } from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import type { FixtureCopy } from './helpers/fixtures'
import { devServerPids } from './helpers/processes'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// A window holds projects as tabs, each with its own preview, chat, dev server and agent;
// background tabs keep running. A stand-in ACP agent (like queue.spec.ts's) does the turns:
// TABS-WORK takes WORK_MS (TABS-LONG, LONG_MS), TABS-ASK waits on a permission card. No login
// or usage needed.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Tabs`
const WORK_MS = 4000
const LONG_MS = 120_000

const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const readline = require('node:readline')
const log = process.argv[2]
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const pending = new Map()
const running = new Map()
let lastId = 1000
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++lastId
    pending.set(id, resolve)
    write({ id, method, params })
  })
const askToRun = async (id, sessionId) => {
  const toolCall = { toolCallId: 'run-1', title: 'npm test', kind: 'execute', status: 'pending' }
  write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', ...toolCall } } })
  const options = [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]
  await ask('session/request_permission', { sessionId, toolCall, options })
  write({ id, result: { stopReason: 'end_turn' } })
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (method === undefined) {
    const resolve = pending.get(id)
    pending.delete(id)
    resolve?.(message.result)
  } else if (method === 'initialize') {
    write({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] } })
  } else if (method === 'session/new') {
    write({ id, result: { sessionId: 'tabs-' + process.pid } })
  } else if (method === 'session/prompt') {
    const text = params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    appendFileSync(log, JSON.stringify(text) + '\n')
    if (text.includes('TABS-ASK')) return void askToRun(id, params.sessionId)
    const timer = setTimeout(() => {
      running.delete(params.sessionId)
      write({ id, result: { stopReason: 'end_turn' } })
    }, text.includes('TABS-LONG') ? ${LONG_MS} : ${WORK_MS})
    running.set(params.sessionId, { id, timer })
  } else if (method === 'session/cancel') {
    const turn = running.get(params.sessionId)
    if (!turn) return
    clearTimeout(turn.timer)
    running.delete(params.sessionId)
    write({ id: turn.id, result: { stopReason: 'cancelled' } })
  } else if (id !== undefined) {
    write({ id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
})
`

/** Makes the stand-in agent the active tab's (and new tabs'); returns the prompts it got. */
async function useTabsAgent(session: GuiSession): Promise<() => string[]> {
  const { base, userData } = session.fixture
  const log = join(base, 'tabs-prompts.ndjson')
  const script = join(base, 'tabs-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Tabs: {
      command: electronExecutable(),
      args: [script, log],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((a) => a.id === AGENT)
  await waitFor(listed, 'the tabs agent to be listed')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  return () => {
    if (!existsSync(log)) return []
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
  }
}

/**
 * A second copy of the Vite fixture, renamed so its tab and page tell it apart, trusted and
 * listed in recent projects like the launched one.
 */
function secondProject(session: GuiSession, copy: FixtureCopy) {
  const pkg = join(copy.root, 'package.json')
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"gui-e2e-vite"', '"second-vite"'))
  const app = join(copy.root, 'src', 'App.tsx')
  writeFileSync(app, readFileSync(app, 'utf8').replace('Gui Vite fixture', 'Second Vite fixture'))
  const { userData, root } = session.fixture
  writeFileSync(join(userData, 'trusted-projects.json'), JSON.stringify([root, copy.root]))
  return copy.root
}

/** Opens a folder as Finder (or the Dock) does. */
function openFromFinder(session: GuiSession, path: string) {
  return session.app.evaluate(({ app }, folder) => {
    app.emit('open-file', { preventDefault: () => undefined }, folder)
  }, path)
}

/** Opens a project not opened before from Finder: on main, it opens straight away too. */
async function openNewFromFinder(session: GuiSession, path: string) {
  await openFromFinder(session, path)
}

/**
 * Clicks a visible item of the app menu by label. Like any script it focuses no window, so the
 * menu acts on the lone window, as it does for the user in the focused one.
 */
function clickMenu(session: GuiSession, label: string) {
  return session.app.evaluate(({ Menu }, name) => {
    type Item = Electron.MenuItem
    const find = (items: Item[]): Item | undefined => {
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

/**
 * Runs in main: the first window's title and traffic lights, and what the views in it show:
 * the previews' addresses and the chat panels' text.
 */
async function windowInfo({ BrowserWindow, WebContentsView }: typeof import('electron/main')) {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const views = win.contentView.children.filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const pages = views.map((view) => view.webContents)
  const chats = pages.filter((wc) => wc.getURL().endsWith('/chat.html'))
  return {
    title: win.getTitle(),
    lights: win.getWindowButtonPosition(),
    previews: pages.map((wc) => wc.getURL()).filter((url) => url.startsWith('http://')),
    chats: await Promise.all(
      chats.map((wc): Promise<string> => wc.executeJavaScript('document.body.innerText')),
    ),
  }
}

/** The chat page that isn't one of `known`: a new tab's. */
async function newChatPage(session: GuiSession, known: Page[]) {
  const find = () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/chat.html') && !known.includes(page))
  const page = await waitFor(find, "the new tab's chat")
  await page.waitForFunction(() => 'gui' in window)
  return page
}

/** Whether Window → Move Tab to New Window can be chosen. */
const canMoveTab = (session: GuiSession) =>
  session.app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('move-tab')?.enabled ?? null,
  )

const tabsOf = async (session: GuiSession) => (await session.state()).tabs
const tabStrip = (session: GuiSession) => session.chrome.getByRole('tablist')
const tabNamed = (session: GuiSession, name: string) =>
  tabStrip(session).getByRole('tab', { name, exact: true })

/** Drags the tab named `from` onto the one named `onto`, with the mouse. */
async function dragTab(session: GuiSession, from: string, onto: string) {
  // Once both have stopped moving: a tab dropped a moment ago, and the ones it passed, are
  // still springing into their slots, and the pointer presses what's drawn under it.
  await tabNamed(session, onto).hover({ trial: true })
  await tabNamed(session, from).hover({ trial: true })
  const start = await tabNamed(session, from).boundingBox()
  const end = await tabNamed(session, onto).boundingBox()
  if (!start || !end) throw new Error('The tabs have no layout box')
  const { mouse } = session.chrome
  await mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await mouse.down()
  await mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 })
  await mouse.up()
}
const turnsIn = async (chat: Page): Promise<Turn[]> =>
  (await chat.evaluate(() => window.gui.getChat())).turns

/** Waits until the tab strip shows `status` for the tab `id`. */
function tabStatus(session: GuiSession, id: string, status: TabInfo['status']) {
  return waitFor(async () => {
    const tab = (await tabsOf(session)).find((t) => t.id === id)
    return tab?.status === status ? tab : null
  }, `tab ${id} to be ${status}`)
}

test('projects open as tabs, each with its own preview, chat and dev server', async ({
  launch,
  copyFixture,
}) => {
  const session = await launch({ fixture: 'vite' })
  const first = await session.waitForPreview()
  const firstRoot = session.fixture.root
  const name = first.project?.name ?? ''
  const recorded = await useTabsAgent(session)

  // One tab: no tab strip, the window as it's always been.
  expect(first.tabs).toEqual([{ id: first.activeTab, title: name, status: 'idle' }])
  await expect(tabStrip(session)).toHaveCount(0)
  expect(await session.app.evaluate(windowInfo)).toMatchObject({
    title: name,
    lights: { x: 16, y: 15 },
  })
  // A lone tab has nowhere to move from.
  expect(await canMoveTab(session)).toBe(false)

  // File → New Tab: a start-screen tab, shown, and the tab row with the traffic lights in it.
  await clickMenu(session, 'New Tab')
  const added = await waitFor(async () => {
    const state = await session.state()
    return state.tabs.length === 2 ? state : null
  }, 'a second tab')
  const startTab = added.activeTab
  expect(added.project).toBeNull()
  expect(added.tabs.map((tab) => tab.title)).toEqual([name, null])
  await expect(tabStrip(session).getByRole('tab')).toHaveText([name, 'New tab'])
  await expect(tabStrip(session).getByRole('tab', { selected: true })).toHaveText('New tab')
  expect(await session.app.evaluate(windowInfo)).toMatchObject({
    title: 'Gui',
    lights: { x: 16, y: 11 },
  })
  await waitFor(() => canMoveTab(session), 'Move Tab to New Window to be enabled')
  // The tablist holds only tabs: each close button is for the pointer, hidden from assistive
  // tech (the keyboard closes with Delete or ⌘W).
  await expect(tabStrip(session).getByRole('button')).toHaveCount(0)
  await expect(tabStrip(session).locator('button[aria-hidden="true"]')).toHaveCount(2)
  const secondChat = await newChatPage(session, [session.chat])
  await session.shot('new-tab')

  // A project opened from Finder goes into that start tab, which takes its name.
  const secondRoot = secondProject(session, copyFixture('vite'))
  await openNewFromFinder(session, secondRoot)
  const opened = await waitFor(
    async () => {
      const state = await session.state()
      const running = state.devServer.status === 'running' && state.preview.visible
      return state.project?.root === secondRoot && running ? state : null
    },
    'the second project to run in the new tab',
    { timeout: 120_000 },
  )
  expect(opened.activeTab).toBe(startTab)
  expect(opened.tabs.map((tab) => tab.title)).toEqual([name, 'second-vite'])
  expect((await session.app.evaluate(windowInfo))?.title).toBe('second-vite')
  expect(await session.windowCount()).toBe(1)

  // Each tab has its own transcript: a turn in the second leaves the first's empty.
  const prompt = 'TABS-WORK in the second tab'
  expect(await secondChat.evaluate((text) => window.gui.send(text), prompt)).toBe(true)
  await waitFor(async () => (await turnsIn(secondChat))[0]?.status === 'done', 'its turn')
  expect(await turnsIn(session.chat)).toEqual([])

  // The window shows the active tab's preview and chat; the other tab's are out of it.
  const shown = async () => (await session.app.evaluate(windowInfo)) ?? { previews: [], chats: [] }
  const second = await shown()
  expect(second.previews).toEqual([opened.preview.url])
  expect(second.chats).toEqual([expect.stringContaining(prompt)])

  // Show Next Tab wraps around to the first, with its own preview and chat; the second
  // project's dev server keeps running in the background.
  await clickMenu(session, 'Show Next Tab')
  const back = await waitFor(async () => {
    const state = await session.state()
    return state.activeTab === first.activeTab ? state : null
  }, 'the first tab')
  expect(back.project?.root).toBe(firstRoot)
  const firstShown = await shown()
  expect(firstShown.previews).toEqual([first.preview.url])
  expect(firstShown.chats).toHaveLength(1)
  expect(firstShown.chats[0]).not.toContain(prompt)
  expect(await turnsIn(session.chat)).toEqual([])
  expect((await turnsIn(secondChat)).map((turn) => turn.prompt)).toEqual([prompt])
  expect(devServerPids(secondRoot).length).toBeGreaterThan(0)
  expect(devServerPids(firstRoot).length).toBeGreaterThan(0)
  await session.shot('two-tabs')

  // Opening a project that's already open (from Finder, or `gui` in a terminal) shows its
  // tab rather than opening it again, with its chat and dev server as they were.
  await openFromFinder(session, secondRoot)
  const shownAgain = await waitFor(async () => {
    const state = await session.state()
    return state.activeTab === startTab ? state : null
  }, 'the project’s tab to show')
  expect(shownAgain.tabs).toHaveLength(2)
  expect(shownAgain.project?.root).toBe(secondRoot)
  expect(await session.windowCount()).toBe(1)
  expect(devServerPids(secondRoot)).toHaveLength(1)
  expect((await turnsIn(secondChat)).map((turn) => turn.prompt)).toEqual([prompt])
  expect(recorded()).toEqual([expect.stringContaining(prompt)])

  // Dragging a tab onto another reorders the strip, either way.
  await dragTab(session, 'second-vite', name)
  await expect(tabStrip(session).getByRole('tab')).toHaveText(['second-vite', name])
  expect((await tabsOf(session)).map((tab) => tab.id)).toEqual([startTab, first.activeTab])
  await dragTab(session, 'second-vite', name)
  await expect(tabStrip(session).getByRole('tab')).toHaveText([name, 'second-vite'])
  expect((await tabsOf(session)).map((tab) => tab.id)).toEqual([first.activeTab, startTab])

  // Middle-clicking a tab closes it, which stops its dev server; one tab is left, without a strip.
  await tabNamed(session, 'second-vite').click({ button: 'middle' })
  const closed = await waitFor(async () => {
    const state = await session.state()
    return state.tabs.length === 1 ? state : null
  }, 'one tab')
  expect(closed.activeTab).toBe(first.activeTab)
  expect(closed.project?.root).toBe(firstRoot)
  await expect(tabStrip(session)).toHaveCount(0)
  expect(await session.app.evaluate(windowInfo)).toMatchObject({
    title: name,
    lights: { x: 16, y: 15 },
  })
  await waitFor(async () => (await canMoveTab(session)) === false, 'Move Tab to be disabled again')
  await waitFor(() => devServerPids(secondRoot).length === 0, 'the closed tab’s dev server to stop')
  expect(secondChat.isClosed()).toBe(true)
  expect(devServerPids(firstRoot).length).toBeGreaterThan(0)

  // Closing the last tab closes the window.
  await clickMenu(session, 'Close Tab')
  await waitFor(async () => (await session.windowCount()) === 0, 'the window to close')
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`background tabs keep working and show it in the strip (${colorScheme})`, async ({
    launch,
    copyFixture,
  }) => {
    const session = await launch({ fixture: 'vite', colorScheme })
    const first = await session.waitForPreview()
    const recorded = await useTabsAgent(session)
    await session.shot(`one-tab-${colorScheme}`)

    // A second project in a new tab, and a third, empty one.
    await session.chrome.evaluate(() => window.gui.newTab())
    const secondChat = await newChatPage(session, [session.chat])
    await openNewFromFinder(session, secondProject(session, copyFixture('vite')))
    const second = await waitFor(
      async () => {
        const state = await session.state()
        return state.preview.visible && state.tabs.length === 2 ? state : null
      },
      'the second project',
      { timeout: 120_000 },
    )
    // Ask, not Auto, so the agent's request waits for the user.
    await secondChat.evaluate(() => window.gui.setAutoApprove(false))
    await session.chrome.evaluate(() => window.gui.newTab())
    await waitFor(async () => (await tabsOf(session)).length === 3, 'a third tab')

    // The first tab's agent works while another tab is shown, and the strip says so.
    await session.chrome.evaluate((id) => window.gui.selectTab(id), first.activeTab)
    expect(await session.chat.evaluate(() => window.gui.send('TABS-WORK first'))).toBe(true)
    await session.chrome.evaluate((id) => window.gui.selectTab(id), second.activeTab)
    await tabStatus(session, first.activeTab, 'working')
    await expect(tabNamed(session, 'gui-e2e-vite, working')).toBeVisible()
    // Its agent gets the prompt while the tab is in the background. Waiting for it also keeps
    // the two tabs' prompts in order: each tab starts its own agent, at its own pace.
    const firstSent = () => recorded().some((prompt) => prompt.includes('TABS-WORK first'))
    await waitFor(firstSent, "the first tab's prompt to reach its agent")

    // The second tab's agent asks; once another tab is shown, its tab waits on the user.
    expect(await secondChat.evaluate(() => window.gui.send('TABS-ASK second'))).toBe(true)
    await waitFor(async () => {
      const turn = (await turnsIn(secondChat))[0]
      return turn?.items.some((item) => item.kind === 'permission' && !item.resolved)
    }, 'the permission card')
    await session.chrome.evaluate((id) => window.gui.selectTab(id), first.activeTab)
    await tabStatus(session, second.activeTab, 'attention')
    await expect(tabNamed(session, 'second-vite, waiting for your answer')).toBeVisible()
    await session.shot(`three-tabs-${colorScheme}`)

    // The background turn finished on its own.
    await session.chrome.evaluate((id) => window.gui.selectTab(id), second.activeTab)
    await tabStatus(session, first.activeTab, 'idle')
    expect((await turnsIn(session.chat))[0]?.status).toBe('done')
    expect(recorded()).toEqual([
      expect.stringContaining('TABS-WORK first'),
      expect.stringContaining('TABS-ASK second'),
    ])

    // Answering the card in the second tab clears its mark.
    const turn = (await turnsIn(secondChat))[0]
    const card = turn?.items.find((item) => item.kind === 'permission')
    if (!turn || !card) throw new Error('The permission card is gone')
    await secondChat.evaluate(
      ([turnId, itemId]) => window.gui.respondPermission(turnId, itemId, 'reject'),
      [turn.id, card.id] as const,
    )
    await tabStatus(session, second.activeTab, 'idle')

    // Window → Move Tab to New Window: the tab goes on in a window of its own.
    await clickMenu(session, 'Move Tab to New Window')
    await waitFor(async () => (await session.windowCount()) === 2, 'a second window')
    const chromes = () =>
      session.app
        .context()
        .pages()
        .filter((page) => page.url().endsWith('/index.html') && page !== session.chrome)
    const moved = await waitFor(() => chromes()[0], "the new window's chrome")
    await moved.waitForFunction(() => 'gui' in window)
    const own = await waitFor(async () => {
      const state = await moved.evaluate(() => window.gui.getState())
      return state.project ? state : null
    }, 'the moved tab in the new window')
    expect(own.tabs).toEqual([{ id: second.activeTab, title: 'second-vite', status: 'idle' }])
    expect(own.devServer.status).toBe('running')
    expect((await turnsIn(secondChat)).map((t) => t.status)).toEqual(['done'])
    const left = await session.state()
    expect(left.tabs.map((tab) => tab.id)).not.toContain(second.activeTab)
    expect(left.tabs).toHaveLength(2)

    // From the keyboard, Delete closes the focused tab.
    await tabNamed(session, 'New tab').focus()
    await session.chrome.keyboard.press('Delete')
    const closed = await waitFor(async () => {
      const state = await session.state()
      return state.tabs.length === 1 ? state : null
    }, 'the start tab to close')
    expect(closed.activeTab).toBe(first.activeTab)
    await expect(tabStrip(session)).toHaveCount(0)
  })
}

/**
 * Runs in a chat page: whether it's been told nobody can see it, how its spinners are playing
 * (each state once), and the Working row's count with the time it was read.
 */
function chatAtRest() {
  const count = [...document.querySelectorAll('p')]
    .map((row) => /^Working (\d+)s$/.exec(row.textContent ?? ''))
    .find((match) => match !== null)
  return {
    unseen: document.documentElement.hasAttribute('data-unseen'),
    spinners: [
      ...new Set(
        document
          .getAnimations()
          .filter((animation) => (animation as CSSAnimation).animationName === 'spin')
          .map((animation) => animation.playState),
      ),
    ],
    seconds: count ? Number(count[1]) : null,
    at: Date.now(),
  }
}

test('a chat nobody can see rests, and is right the moment it is seen again', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const first = await session.waitForPreview()
  await useTabsAgent(session)
  const { chat, chrome } = session
  await session.expandChat()
  expect(await chat.evaluate(() => window.gui.send('TABS-LONG'))).toBe(true)
  const rest = () => chat.evaluate(chatAtRest)
  const startedAt = async () => (await turnsIn(chat))[0]?.startedAt ?? Number.NaN
  /** How far the count shown is from the turn's real age, in seconds. */
  const off = async (shown: { seconds: number | null; at: number }) =>
    Math.abs((shown.seconds ?? Number.NaN) - (shown.at - (await startedAt())) / 1000)

  // In front, the agent working: the spinner turns and the count keeps up.
  await waitFor(async () => (await rest()).seconds !== null, 'the Working row')
  expect(await rest()).toMatchObject({ unseen: false, spinners: ['running'] })

  /**
   * Out of sight by `hide`, the chat holds still: its spinner paused and its count stopped,
   * while it goes on taking in what main sends. Back in sight by `show`, the spinner turns and
   * the count is the turn's age in the first frame drawn, not the old one until the next tick.
   */
  const restsWhile = async (
    label: string,
    hide: () => Promise<unknown>,
    show: () => Promise<unknown>,
  ) => {
    await hide()
    await waitFor(async () => (await rest()).unseen, `the chat to rest (${label})`)
    const held = await rest()
    expect(held.spinners, label).toEqual(['paused'])
    // Longer than the count's tick, and long enough that a stale count would be seen as one.
    await sleep(3200)
    expect((await rest()).seconds, label).toBe(held.seconds)
    // Still listening: main's word of its state arrives as ever.
    const meta = await chat.evaluate(() => window.gui.getChat().then((snapshot) => snapshot.seen))
    expect(meta, label).toBe(false)
    await chat.evaluate(() => {
      const root = document.documentElement
      const page = window as unknown as { seenAgain?: ReturnType<typeof read> }
      const read = () => {
        const count = [...document.querySelectorAll('p')]
          .map((row) => /^Working (\d+)s$/.exec(row.textContent ?? ''))
          .find((match) => match !== null)
        return { seconds: count ? Number(count[1]) : null, at: Date.now() }
      }
      page.seenAgain = undefined
      new MutationObserver((_records, observer) => {
        if (root.hasAttribute('data-unseen')) return
        observer.disconnect()
        // What the first frame in sight draws.
        requestAnimationFrame(() => {
          page.seenAgain = read()
        })
      }).observe(root, { attributes: true, attributeFilter: ['data-unseen'] })
    })
    await show()
    type Shown = { seconds: number | null; at: number }
    const again = await waitFor(
      () => chat.evaluate(() => (window as unknown as { seenAgain?: Shown }).seenAgain),
      `the chat in sight again (${label})`,
    )
    expect(await off(again), label).toBeLessThan(0.6)
    expect(again.seconds, label).toBeGreaterThanOrEqual((held.seconds ?? 0) + 3)
    expect(await rest(), label).toMatchObject({ unseen: false, spinners: ['running'] })
    // And it counts on from there.
    await waitFor(async () => ((await rest()).seconds ?? 0) > (again.seconds ?? 0), 'the count')
  }

  // Its tab in the background.
  await restsWhile(
    'background tab',
    async () => {
      await chrome.evaluate(() => window.gui.newTab())
      await waitFor(async () => (await tabsOf(session)).length === 2, 'a second tab')
    },
    () => chrome.evaluate((id) => window.gui.selectTab(id), first.activeTab),
  )
  // The chat hidden (⌘B), and shown again.
  await restsWhile(
    'chat hidden',
    () => chat.evaluate(() => window.gui.toggleChat()),
    () => chrome.evaluate(() => window.gui.toggleChat()),
  )
  // The window hidden, as ⌘H does, and shown again. macOS reports a window going or coming
  // by what's really on screen, which a see-through test window never is: the test says so
  // itself, as Electron would.
  const showWindow = (shown: boolean) =>
    session.app.evaluate(({ BrowserWindow }, show) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (show) win?.showInactive()
      else win?.hide()
      win?.emit(show ? 'show' : 'hide')
    }, shown)
  await restsWhile(
    'window hidden',
    () => showWindow(false),
    () => showWindow(true),
  )

  // Popped out, the chat is in a window of its own: in sight there, at rest with its tab, and
  // in sight again back in the window.
  const second = (await tabsOf(session)).find((tab) => tab.id !== first.activeTab)
  if (!second) throw new Error('The second tab is gone')
  const inSight = async (label: string) => {
    await waitFor(async () => !(await rest()).unseen, label, { timeout: 5000 })
    expect((await rest()).spinners, label).toEqual(['running'])
  }
  await chat.evaluate(() => window.gui.togglePopOut())
  await waitFor(async () => (await session.windowCount()) === 2, 'the chat in its own window')
  await inSight('the popped-out chat in sight')
  await restsWhile(
    'popped out, its tab in the background',
    () => chrome.evaluate((id) => window.gui.selectTab(id), second.id),
    () => chrome.evaluate((id) => window.gui.selectTab(id), first.activeTab),
  )
  await chat.evaluate(() => window.gui.togglePopOut())
  await waitFor(async () => (await session.windowCount()) === 1, 'the chat back in the window')
  await inSight('the chat in sight, back in the window')

  // A chat page that loads out of sight starts at rest: it asks main as it loads.
  await chrome.evaluate((id) => window.gui.selectTab(id), second.id)
  await waitFor(async () => (await rest()).unseen, 'the chat to rest again')
  await chat.reload()
  await chat.waitForFunction(() => 'gui' in window)
  await waitFor(async () => (await rest()).seconds !== null, 'the reloaded chat to draw its turn')
  expect(await rest()).toMatchObject({ unseen: true, spinners: ['paused'] })
  await chrome.evaluate((id) => window.gui.selectTab(id), first.activeTab)
  await waitFor(async () => !(await rest()).unseen, 'the reloaded chat in sight')
  const shown = await rest()
  expect(shown.spinners).toEqual(['running'])
  expect(await off(shown)).toBeLessThan(1.6)
  await chat.evaluate(() => window.gui.cancel())
})
