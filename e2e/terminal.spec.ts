import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalId } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The drawer's terminals: the user's own login shell at the project root, started only when
// they open one (⌘J or +), typed into from the drawer, and ended with everything it started
// when its terminal, its project tab or window closes, or Gui quits. Their output, and the dev
// server's, reaches the drawer only while it shows, at the pace the drawer draws it.
//
// The shell is zsh, which every Mac has (CI's login shell may be another), started from an
// empty config folder: the developer's own ~/.zshrc doesn't run, and nothing typed here ends up
// in their shell history. The commands are plain POSIX, so nothing depends on the prompt.

const ZDOTDIR = mkdtempSync(join(tmpdir(), 'gui-e2e-zsh-'))
const SHELL = { SHELL: '/bin/zsh', ZDOTDIR }
test.afterAll(() => rmSync(ZDOTDIR, { recursive: true, force: true }))

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

const drawer = (session: GuiSession) => session.chrome.getByRole('region', { name: 'Terminal' })
const tabs = (session: GuiSession) => session.chrome.getByRole('tablist', { name: 'Terminal tabs' })
const panel = (session: GuiSession, id: TerminalId) =>
  session.chrome.locator(`[id="drawer-panel-${id}"]`)

/** The drawer with `count` terminals, once main says so. */
function drawerWith(session: GuiSession, count: number) {
  return waitFor(async () => {
    const { drawer } = await session.state()
    return drawer.terminals.length === count ? drawer : null
  }, `the drawer with ${count} terminal(s)`)
}

/** Everything the terminal has printed, as main keeps it to draw it again. */
function output(session: GuiSession, id: TerminalId) {
  return session.chrome.evaluate(
    async (terminal) => (await window.gui.getTerminal(terminal)).data,
    id,
  )
}

function waitForOutput(session: GuiSession, id: TerminalId, pattern: RegExp, label: string) {
  return waitFor(async () => (await output(session, id)).match(pattern), label, {
    timeout: 30_000,
  })
}

/** Types a command into the terminal with the keyboard and runs it. */
async function run(session: GuiSession, command: string) {
  await session.chrome.keyboard.type(` ${command}`)
  await session.chrome.keyboard.press('Enter')
}

/** The terminal's shell, by the pid it prints for `$$`. */
async function shellPid(session: GuiSession, id: TerminalId, tag: string) {
  await run(session, `echo ${tag}:$$`)
  const match = await waitForOutput(session, id, new RegExp(`${tag}:(\\d+)`), `${tag}'s pid`)
  return Number(match[1])
}

/**
 * A background job in the terminal, which job control gives a process group of its own. It
 * ignores the hangup, so only Gui ending it (not the shell passing the hangup on) gets rid of it.
 */
async function startJob(session: GuiSession, id: TerminalId, tag: string) {
  await run(session, `(trap '' HUP; exec sleep 300) & echo ${tag}:$!`)
  const match = await waitForOutput(session, id, new RegExp(`${tag}:(\\d+)`), `${tag}'s pid`)
  return Number(match[1])
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForGone(pids: number[], label: string) {
  return waitFor(() => pids.every((pid) => !alive(pid)), label, { timeout: 15_000 })
}

/** The drawer panel the keyboard is in, if any. */
function focusedPanel(session: GuiSession) {
  return session.chrome.evaluate(() => {
    const el = document.activeElement
    if (!el?.classList.contains('xterm-helper-textarea')) return null
    return el.closest('[role="tabpanel"]')?.id ?? null
  })
}

function waitForFocus(session: GuiSession, id: TerminalId) {
  return waitFor(
    async () => (await focusedPanel(session)) === `drawer-panel-${id}`,
    `the keyboard in ${id}`,
  )
}

/** Records, in the chrome page, whether the page handled each ⌘ key pressed from now on. */
function recordKeys() {
  const keys: { key: string; handled: boolean }[] = []
  Object.assign(window, { guiKeys: keys })
  window.addEventListener('keydown', (event) => {
    if (event.metaKey && event.key !== 'Meta') {
      keys.push({ key: event.key.toLowerCase(), handled: event.defaultPrevented })
    }
  })
}

test('⌘J opens a terminal at the project root; it takes keys, copy and paste, and ⌘K', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', env: SHELL })
  const state = await session.waitForPreview()
  const root = state.project?.root ?? ''
  // Nothing runs in a terminal until the user opens one.
  expect(state.drawer).toEqual({ open: false, tab: null, terminals: [] })

  // View → Toggle Terminal (⌘J): the first time, a new terminal, with the keyboard in it.
  await clickMenu(session, 'Toggle Terminal')
  const opened = await drawerWith(session, 1)
  const first = opened.terminals[0]?.id
  if (!first) throw new Error('No terminal')
  expect(opened).toMatchObject({ open: true, tab: first })
  await expect(tabs(session).getByRole('tab')).toHaveText(['Dev server', 'Terminal'])
  await expect(tabs(session).getByRole('tab', { name: 'Terminal', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await waitForFocus(session, first)

  await run(session, 'echo gui-$((40+2))')
  await waitForOutput(session, first, /gui-42/, 'the echo')
  await expect(panel(session, first).locator('.xterm-rows')).toContainText('gui-42')
  await run(session, 'echo "cwd:$(pwd -P)"')
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await waitForOutput(session, first, new RegExp(`cwd:${escaped}\\r?\\n`), 'the working directory')
  await session.shot('terminal')

  // Ctrl-C goes to the shell: it stops the sleep, and the next command runs at once.
  await run(session, 'sleep 30')
  await sleep(500)
  await session.chrome.keyboard.press('Control+C')
  await run(session, 'echo after-$((1+1))')
  await waitFor(async () => /after-2/.test(await output(session, first)), 'the shell after ^C', {
    timeout: 10_000,
  })

  // The app menu's keys aren't the terminal's: the page leaves them alone, so ⌘W still closes
  // the project tab and ⌘J the drawer. ⌘A selects everything in the terminal on its way.
  await session.chrome.evaluate(recordKeys)
  for (const key of ['Meta+j', 'Meta+l', 'Meta+w', 'Meta+t', 'Meta+a']) {
    await session.chrome.keyboard.press(key)
  }
  const keys = await session.chrome.evaluate(
    () => (window as unknown as { guiKeys: { key: string; handled: boolean }[] }).guiKeys,
  )
  expect(keys).toEqual([
    { key: 'j', handled: false },
    { key: 'l', handled: false },
    { key: 'w', handled: false },
    { key: 't', handled: false },
    { key: 'a', handled: false },
  ])

  // Edit → Copy copies what's selected in the terminal; Edit → Paste types into it. The drawer
  // can draw the output a moment after main has it, so select and copy until it's there.
  const copy = () =>
    session.app.evaluate(({ BrowserWindow, clipboard }) => {
      clipboard.clear()
      BrowserWindow.getAllWindows()[0]?.webContents.copy()
      return new Promise<string>((resolve) => setTimeout(() => resolve(clipboard.readText()), 300))
    })
  await waitFor(
    async () => {
      await session.chrome.keyboard.press('Meta+a')
      return (await copy()).includes('after-2')
    },
    "the terminal's selection to include the output",
    { timeout: 10_000 },
  )
  await session.app.evaluate(({ BrowserWindow, clipboard }) => {
    clipboard.writeText(' echo pasted-$((6*7))')
    BrowserWindow.getAllWindows()[0]?.webContents.paste()
  })
  await session.chrome.keyboard.press('Enter')
  await waitForOutput(session, first, /pasted-42/, 'the pasted command')

  // ⌘K clears the terminal, and what main keeps to draw it again.
  await expect(panel(session, first).locator('.xterm-rows')).toContainText('gui-42')
  await session.chrome.keyboard.press('Meta+k')
  await expect(panel(session, first).locator('.xterm-rows')).not.toContainText('gui-42')
  expect(await output(session, first)).not.toContain('gui-42')
  await run(session, 'echo cleared-$((2+3))')
  await waitForOutput(session, first, /cleared-5/, 'output after ⌘K')
})

test('a second terminal, closing one, exit and restart, other tabs, and ⌘W', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', env: SHELL })
  const { activeTab: projectTab } = await session.waitForPreview()
  await clickMenu(session, 'Toggle Terminal')
  const first = (await drawerWith(session, 1)).terminals[0]?.id
  if (!first) throw new Error('No terminal')
  await waitForFocus(session, first)

  // + adds a second terminal and shows it.
  await drawer(session).getByRole('button', { name: 'New terminal' }).click()
  const two = await drawerWith(session, 2)
  const second = two.terminals[1]?.id
  if (!second) throw new Error('No second terminal')
  expect(two.tab).toBe(second)
  await expect(tabs(session).getByRole('tab')).toHaveText(['Dev server', 'Terminal', 'Terminal 2'])
  await waitForFocus(session, second)
  const secondShell = await shellPid(session, second, 'second')
  const secondJob = await startJob(session, second, 'second-job')
  expect([alive(secondShell), alive(secondJob)]).toEqual([true, true])
  await session.shot('two-terminals')

  // Its × ends its shell and the job the shell started; the drawer shows the first again.
  await session.chrome.getByTitle('Close Terminal 2').click()
  const one = await drawerWith(session, 1)
  expect(one.tab).toBe(first)
  await waitForGone([secondShell, secondJob], 'the second shell and its job to end')
  await waitForFocus(session, first)

  // `exit` ends the shell but keeps the terminal, which says so and offers a new shell.
  const exitedShell = await shellPid(session, first, 'first')
  await run(session, 'exit')
  await waitFor(async () => (await session.state()).drawer.terminals[0]?.exited, 'the exit')
  await expect(panel(session, first).locator('.xterm-rows')).toContainText('[process exited]')
  await expect(tabs(session).getByRole('tab', { name: 'Terminal, exited' })).toBeVisible()
  await waitForGone([exitedShell], 'the exited shell')
  await session.shot('exited')
  await drawer(session).getByRole('button', { name: 'Restart' }).click()
  await waitFor(async () => {
    const terminal = (await session.state()).drawer.terminals[0]
    return terminal && !terminal.exited
  }, 'a new shell')
  await waitForFocus(session, first)
  await run(session, 'echo again-$((2+2))')
  await waitForOutput(session, first, /again-4/, 'the new shell')

  // In a background tab the shell keeps running; back in its tab, the terminal shows what it
  // printed meanwhile, and takes keys again.
  await run(session, 'sleep 2; echo later-$((5+5))')
  await session.chrome.evaluate(() => window.gui.newTab())
  await waitFor(async () => (await session.state()).project === null, 'the new tab')
  await expect(drawer(session)).toHaveCount(0)
  await sleep(3_000)
  await session.chrome.evaluate((id) => window.gui.selectTab(id), projectTab)
  const rows = panel(session, first).locator('.xterm-rows')
  await expect(rows).toContainText('again-4')
  await expect(rows).toContainText('later-10')
  await panel(session, first).click()
  await waitForFocus(session, first)
  await run(session, 'echo back-$((3+3))')
  await waitForOutput(session, first, /back-6/, 'typing after switching back')

  // With the keyboard in the terminal, File → Close Tab (⌘W) closes the project's tab, as
  // always, and that ends its shells and their jobs.
  const shell = await shellPid(session, first, 'last')
  const job = await startJob(session, first, 'last-job')
  await drawer(session).getByRole('button', { name: 'New terminal' }).click()
  const third = (await drawerWith(session, 2)).terminals[1]?.id
  if (!third) throw new Error('No third terminal')
  await waitForFocus(session, third)
  const thirdShell = await shellPid(session, third, 'third')
  await clickMenu(session, 'Close Tab')
  await waitFor(async () => (await session.state()).tabs.length === 1, 'the project tab to close')
  expect((await session.state()).project).toBeNull()
  await waitForGone([shell, job, thirdShell], "the closed tab's shells and job to end")
})

/**
 * Records, in the chrome page, the drawer's output messages from now on (terminals' and the dev
 * server's), and how late a 20ms timer runs: the page's own work, as its animations and input.
 */
function startProbe() {
  const probe: Probe = { messages: [], timerLate: 0 }
  Object.assign(window, { guiProbe: probe })
  const record = (output: { id: string; data: string }) => {
    probe.messages.push({ id: output.id, chars: output.data.length })
  }
  window.gui.onTerminalData(record)
  window.gui.onLogs(record)
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    probe.timerLate = Math.max(probe.timerLate, now - last - 20)
    last = now
  }, 20)
}

interface Probe {
  messages: { id: string; chars: number }[]
  timerLate: number
}

/** Starts the probe's numbers over. */
function resetProbe(session: GuiSession) {
  return session.chrome.evaluate(() => {
    const probe = (window as unknown as { guiProbe: Probe }).guiProbe
    probe.messages.length = 0
    probe.timerLate = 0
  })
}

/**
 * While something floods: every 100ms for `seconds`, a state round trip from the chrome page
 * through main, timed in the page and as the test waits for it. Then the probe's numbers for
 * that time, for output whose id starts with `id`.
 */
async function measureFlood(session: GuiSession, id: string, seconds: number) {
  await resetProbe(session)
  const inPage: number[] = []
  const total: number[] = []
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const start = Date.now()
    inPage.push(
      await session.chrome.evaluate(async () => {
        const at = performance.now()
        await window.gui.getState()
        return performance.now() - at
      }),
    )
    total.push(Date.now() - start)
    await sleep(100)
  }
  const probe = await session.chrome.evaluate(
    () => (window as unknown as { guiProbe: Probe }).guiProbe,
  )
  const messages = probe.messages.filter((message) => message.id.startsWith(id))
  const flood = {
    messagesPerSecond: messages.length / seconds,
    megabytesPerSecond: messages.reduce((sum, { chars }) => sum + chars, 0) / seconds / 1e6,
    roundTrip: Math.max(...inPage),
    roundTripFromTest: Math.max(...total),
    timerLate: probe.timerLate,
  }
  console.log(`[flood] ${id}: ${JSON.stringify(flood)}`)
  return flood
}

/**
 * The page stayed responsive and got the output in few messages: the numbers are generous for
 * CI's slower runners. (Before flow control, a laptop saw ~25,000 messages a second.)
 */
function expectResponsive(flood: Awaited<ReturnType<typeof measureFlood>>) {
  expect(flood.messagesPerSecond).toBeGreaterThan(0)
  expect(flood.messagesPerSecond).toBeLessThan(600)
  expect(flood.roundTrip).toBeLessThan(500)
  expect(flood.roundTripFromTest).toBeLessThan(1000)
  expect(flood.timerLate).toBeLessThan(500)
}

/** Where the terminal's output has got to, in main. */
function outputEnd(session: GuiSession, id: TerminalId) {
  return session.chrome.evaluate(
    async (terminal) => (await window.gui.getTerminal(terminal)).end,
    id,
  )
}

test('a flood of output keeps Gui responsive, ⌃C stops it, and what follows is intact', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', env: SHELL })
  await session.waitForPreview()
  await clickMenu(session, 'Toggle Terminal')
  const id = (await drawerWith(session, 1)).terminals[0]?.id
  if (!id) throw new Error('No terminal')
  await waitForFocus(session, id)
  await session.chrome.evaluate(startProbe)
  const rows = panel(session, id).locator('.xterm-rows')

  // `yes` prints as fast as the terminal reads: the drawer gets it in a few large messages, at
  // the pace it draws them, and the page keeps up with its own work and main's replies.
  await run(session, 'yes gui-flood')
  await waitForOutput(session, id, /(gui-flood\r\n){100}/, 'the flood')
  expectResponsive(await measureFlood(session, id, 5))
  await expect(rows).toContainText('gui-flood')

  // Out of sight (the drawer on the dev server's output), none of it is sent, and the shell
  // isn't held: main goes on reading it. Back in sight, the terminal shows where it's got to.
  await tabs(session).getByRole('tab', { name: 'Dev server' }).click()
  await sleep(300)
  const hidden = await outputEnd(session, id)
  expect((await measureFlood(session, id, 2)).messagesPerSecond).toBe(0)
  expect((await outputEnd(session, id)) - hidden).toBeGreaterThan(1_000_000)
  await tabs(session).getByRole('tab', { name: 'Terminal', exact: true }).click()
  await waitForFocus(session, id)
  await expect(rows).toContainText('gui-flood')

  // ⌃C stops it at once, and the shell's prompt comes back to run the next command.
  const stop = Date.now()
  await session.chrome.keyboard.press('Control+C')
  await run(session, 'echo after-$((2+2))')
  await expect(rows).toContainText('after-4', { timeout: 10_000 })
  console.log(`[flood] ⌃C to the next command's output: ${Date.now() - stop}ms`)

  // A flood that ends: all of it arrives, in order, and what follows it too.
  await run(session, 'seq 1 300000; echo seq-$((3+4))')
  await expect(rows).toContainText('seq-7', { timeout: 60_000 })
  expect(await output(session, id)).toMatch(/\r\n299999\r\n300000\r\nseq-7\r\n/)
  const lines = (await rows.locator(':scope > div').allInnerTexts()).map((line) => line.trim())
  const end = lines.indexOf('300000')
  expect(end).toBeGreaterThan(2)
  expect(lines.slice(end - 3, end + 2)).toEqual(['299997', '299998', '299999', '300000', 'seq-7'])
})

test("the dev server's flood reaches the drawer in a few messages, only while it shows", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', env: SHELL })
  await session.waitForPreview()
  await session.chrome.evaluate(startProbe)
  const logs = () => session.chrome.evaluate(() => window.gui.getLogs())
  const rows = session.chrome.locator('[id="drawer-panel-server"] .xterm-rows')

  // The dev script, as a restart runs it, prints as fast as it can; it isn't held for the drawer.
  const file = join(session.fixture.root, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...pkg, scripts: { dev: 'yes gui-server-flood' } }))
  await session.chrome.evaluate(() => window.gui.showLogs())
  await session.chrome.evaluate(() => window.gui.restartDevServer())
  await waitFor(
    async () => /(gui-server-flood\r\n){100}/.test((await logs()).data),
    'the flood in the logs',
  )
  expectResponsive(await measureFlood(session, 'logs-', 4))
  await expect(rows).toContainText('gui-server-flood')

  // With a terminal on screen instead, none of it is sent, though it goes on.
  await session.chrome.evaluate(() => window.gui.newTerminal())
  await drawerWith(session, 1)
  await sleep(300)
  const hidden = (await logs()).end
  expect((await measureFlood(session, 'logs-', 2)).messagesPerSecond).toBe(0)
  expect((await logs()).end - hidden).toBeGreaterThan(1_000_000)

  // Stopped, it says so under the last of the flood.
  await session.chrome.evaluate(() => window.gui.stopDevServer())
  await waitFor(async () => (await session.state()).devServer.status === 'idle', 'the stop')
  await session.chrome.evaluate(() => window.gui.showLogs())
  await expect(rows).toContainText('[process exited with code')
  await expect(rows).toContainText('gui-server-flood')
})

test('closing the window ends its terminals', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', env: SHELL })
  await session.waitForPreview()
  await session.chrome.evaluate(() => window.gui.newTerminal())
  const id = (await drawerWith(session, 1)).terminals[0]?.id
  if (!id) throw new Error('No terminal')
  await waitForFocus(session, id)
  const shell = await shellPid(session, id, 'shell')
  const job = await startJob(session, id, 'job')

  await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await waitFor(async () => (await session.windowCount()) === 0, 'the window to close')
  await waitForGone([shell, job], 'the shell and its job to end')
})

test('quitting Gui ends its terminals', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', env: SHELL })
  await session.waitForPreview()
  await session.chrome.evaluate(() => window.gui.newTerminal())
  const id = (await drawerWith(session, 1)).terminals[0]?.id
  if (!id) throw new Error('No terminal')
  await waitForFocus(session, id)
  const shell = await shellPid(session, id, 'shell')
  const job = await startJob(session, id, 'job')

  await session.close()
  await waitForGone([shell, job], 'the shell and its job to end')
})
