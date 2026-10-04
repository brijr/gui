import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalId } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The drawer's terminals: the user's own login shell at the project root, started only when
// they open one (⌘J or +), typed into from the drawer, and ended with everything it started
// when its terminal, its project tab or window closes, or Gui quits.
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
