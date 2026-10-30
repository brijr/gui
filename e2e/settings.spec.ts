import { realpathSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { SettingsState } from '../src/shared/types'
import { waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

/** The Settings window's page, once its preload is up. */
async function settingsPage(session: GuiSession): Promise<Page> {
  const find = () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/settings.html'))
  const page = await waitFor(find, 'the Settings window', { timeout: 30_000 })
  await page.waitForFunction(() => 'gui' in window)
  return page
}

/** Polls the Settings state until `check` passes. */
function settingsWhere(page: Page, label: string, check: (settings: SettingsState) => boolean) {
  return waitFor(async () => {
    const settings = await page.evaluate(() => window.gui.getSettings())
    return check(settings) ? settings : null
  }, label)
}

type ElectronModule = typeof import('electron/main')

/** Runs in main: the agents the app's Agent menu offers, by name. */
function appMenuAgents({ Menu }: ElectronModule) {
  const agent = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Agent')
  // Items without one have no id at all, whatever the types say.
  return (agent?.submenu?.items ?? [])
    .filter((item) => item.id?.startsWith('agent:'))
    .map((item) => item.label)
}

/**
 * Runs in main: records each menu the app sets, as it shows (labels, states, submenus),
 * starting with the one it has now.
 */
function recordMenus({ Menu }: ElectronModule) {
  const shown = (menu: Electron.Menu | null): unknown =>
    menu?.items.map((item) => ({
      id: item.id,
      type: item.type,
      label: item.label,
      sublabel: item.sublabel,
      enabled: item.enabled,
      checked: item.checked,
      visible: item.visible,
      submenu: shown(item.submenu ?? null),
    })) ?? null
  const store = globalThis as unknown as { guiMenus?: string[] }
  store.guiMenus = [JSON.stringify(shown(Menu.getApplicationMenu()))]
  const set = Menu.setApplicationMenu.bind(Menu)
  Menu.setApplicationMenu = (menu) => {
    store.guiMenus?.push(JSON.stringify(shown(menu)))
    set(menu)
  }
}

/** Screenshots only on request (GUI_E2E_SHOTS=1), like the session helper's. */
async function shot(page: Page, name: string) {
  if (process.env.GUI_E2E_SHOTS !== '1') return
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}

// No agent usage: checks only start (and never prompt) a session, Pi's is /usr/bin/true,
// and the custom agent added here is /bin/echo, which is never run.
test('settings switches agents, edits custom agents, and manages projects', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const root = realpathSync(session.fixture.root)
  // Agent checks change agent health at every step; the app menu is rebuilt only for the
  // changes it shows, so no rebuild leaves it as it was.
  await session.app.evaluate(recordMenus)
  // A stand-in that exits at once, so Pi is found (Settings looks again when it opens) and
  // its check fails fast.
  writeFileSync(standInsFile(session.fixture), JSON.stringify({ pi: { command: '/usr/bin/true' } }))

  // Record titles from the first render, so an Agents flash cannot pass this check.
  await session.app.context().addInitScript(() => {
    const titles: string[] = []
    Object.assign(window, { settingsTitles: titles })
    new MutationObserver(() => {
      const title = document.querySelector('h1')?.textContent?.trim()
      if (title && titles.at(-1) !== title) titles.push(title)
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
  // Opened at a section from the project window; the page shows that section.
  await session.chrome.evaluate(() => window.gui.openSettings('storage'))
  const page = await settingsPage(session)
  await expect(page.getByRole('heading', { level: 1, name: 'Storage' })).toBeVisible()
  expect(
    await page.evaluate(
      () => (window as unknown as { settingsTitles: string[] }).settingsTitles[0],
    ),
  ).toBe('Storage')
  const measured = await settingsWhere(page, 'storage to be measured', (s) =>
    Object.values(s.storage).every((size) => size !== null),
  )
  expect(measured.openProjects).toContain(root)
  await shot(page, 'storage')

  // Switching an agent off hides it from the project window too, and back on restores it.
  await page.getByRole('button', { name: 'Agents' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
  await shot(page, 'agents')
  const codex = page.getByRole('switch', { name: 'Codex', exact: true })
  await expect(codex).toHaveAttribute('aria-checked', 'true')
  // Unpackaged, as in tests, Codex is always found (in node_modules), so it's listed.
  expect(await session.app.evaluate(appMenuAgents)).toContain('Codex')
  await codex.click()
  await settingsWhere(page, 'Codex to be off', (s) =>
    s.agents.some((agent) => agent.id === 'codex' && !agent.enabled),
  )
  const windowAgents = async () => (await session.state()).agents
  const codexOff = async () =>
    (await windowAgents()).find((a) => a.id === 'codex')?.enabled === false
  await waitFor(codexOff, 'the project window to see Codex off')
  // The app menu changed with it, before anything else could see the change.
  expect(await session.app.evaluate(appMenuAgents)).not.toContain('Codex')
  await codex.click()
  await expect(codex).toHaveAttribute('aria-checked', 'true')

  // Switched back on unchecked, Pi is checked at once. Its first step, Checking, doesn't
  // show in the menu, so the switch and that step rebuild it once; its failure shows.
  await settingsWhere(page, 'the stand-in Pi to be found', (s) =>
    s.agents.some((agent) => agent.id === 'pi' && agent.status === 'unknown'),
  )
  const pi = page.getByRole('switch', { name: 'Pi', exact: true })
  await pi.click()
  await settingsWhere(page, 'Pi to be off', (s) =>
    s.agents.some((agent) => agent.id === 'pi' && !agent.enabled),
  )
  expect(await session.app.evaluate(appMenuAgents)).not.toContain('Pi')
  await pi.click()
  await settingsWhere(page, "Pi's check to fail", (s) =>
    s.agents.some((agent) => agent.id === 'pi' && agent.status === 'error'),
  )
  expect(await session.app.evaluate(appMenuAgents)).toContain('Pi')

  // A custom agent added in the form is saved, found on disk, and removable.
  await page.getByRole('button', { name: 'Custom agents' }).click()
  await page.getByRole('button', { name: 'Add agent' }).click()
  await page.getByLabel('Name').fill('Echo')
  await page.getByLabel('Command').fill('/bin/echo')
  await page.getByLabel('Arguments').fill('--acp')
  await shot(page, 'custom-agent-form')
  // The form's submit button replaces the one that opened it.
  await page.getByRole('button', { name: 'Add agent' }).click()
  const added = await settingsWhere(page, 'the custom agent to be added', (s) =>
    s.agents.some((agent) => agent.id === 'custom:Echo' && agent.status !== 'not-installed'),
  )
  expect(added.customAgents).toEqual([
    { name: 'Echo', command: '/bin/echo', args: ['--acp'], env: {} },
  ])
  expect(await session.app.evaluate(appMenuAgents)).toContain('Echo')
  await shot(page, 'agents-with-custom')
  // Removing asks first; the second Remove confirms.
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Remove Echo from agents.json?')).toBeVisible()
  await page.getByRole('button', { name: 'Remove' }).click()
  await settingsWhere(
    page,
    'the custom agent to be removed',
    (s) => s.customAgents.length === 0 && !s.agents.some((agent) => agent.id === 'custom:Echo'),
  )
  expect(await session.app.evaluate(appMenuAgents)).not.toContain('Echo')

  // Chat defaults are what new windows and chats start with.
  await page.getByLabel('Default agent').selectOption('codex')
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('switch', { name: 'Show the chat as a sidebar' }).click()
  await settingsWhere(
    page,
    'the chat defaults to change',
    (s) => s.defaultAgentId === 'codex' && s.chatSidebar,
  )
  await shot(page, 'chat')

  // Revoking trust means the dev script asks again next time.
  await page.getByRole('button', { name: 'Projects' }).click()
  expect((await page.evaluate(() => window.gui.getSettings())).trustedProjects).toContain(root)
  await shot(page, 'projects')
  await page.getByRole('button', { name: `Revoke trust for ${root}` }).click()
  await settingsWhere(page, 'trust to be revoked', (s) => !s.trustedProjects.includes(root))

  const menus = await session.app.evaluate(
    () => (globalThis as unknown as { guiMenus?: string[] }).guiMenus ?? [],
  )
  // Echo's adding and removal rebuilt it at least.
  expect(menus.length).toBeGreaterThan(2)
  const unchanged = menus.flatMap((menu, i) => (i > 0 && menu === menus[i - 1] ? [i] : []))
  expect(unchanged, 'rebuilds that change nothing').toEqual([])
})
