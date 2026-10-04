import { realpathSync } from 'node:fs'
import type { Page } from '@playwright/test'
import type { SettingsState } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
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

/** Screenshots only on request (GUI_E2E_SHOTS=1), like the session helper's. */
async function shot(page: Page, name: string) {
  if (process.env.GUI_E2E_SHOTS !== '1') return
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}

// No agent usage: checks only start (and never prompt) a session, and the custom agent
// added here is /bin/echo, which is never run.
test('settings switches agents, edits custom agents, and manages projects', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const root = realpathSync(session.fixture.root)

  // Opened at a section from the project window; the page shows that section.
  await session.chrome.evaluate(() => window.gui.openSettings('storage'))
  const page = await settingsPage(session)
  await expect(page.getByRole('heading', { level: 1, name: 'Storage' })).toBeVisible()
  const measured = await settingsWhere(page, 'storage to be measured', (s) =>
    Object.values(s.storage).every((size) => size !== null),
  )
  expect(measured.openProjects).toContain(root)
  await shot(page, 'storage')

  // Switching an agent off hides it from the project window too, and back on restores it.
  await page.getByRole('button', { name: 'Agents' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
  await shot(page, 'agents')
  const codex = page.getByRole('switch', { name: 'Codex Enabled' })
  await expect(codex).toHaveAttribute('aria-checked', 'true')
  await codex.click()
  await settingsWhere(page, 'Codex to be off', (s) =>
    s.agents.some((agent) => agent.id === 'codex' && !agent.enabled),
  )
  const windowAgents = async () => (await session.state()).agents
  const codexOff = async () =>
    (await windowAgents()).find((a) => a.id === 'codex')?.enabled === false
  await waitFor(codexOff, 'the project window to see Codex off')
  await codex.click()
  await expect(codex).toHaveAttribute('aria-checked', 'true')

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
  await shot(page, 'agents-with-custom')
  // Removing asks first; the second Remove confirms.
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Remove Echo from agents.json?')).toBeVisible()
  await page.getByRole('button', { name: 'Remove' }).click()
  await settingsWhere(page, 'the custom agent to be removed', (s) => s.customAgents.length === 0)

  // Chat defaults are what new windows and chats start with.
  await page.getByLabel('Default agent').selectOption('codex')
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('switch', { name: 'Start the chat docked to the side' }).click()
  await settingsWhere(
    page,
    'the chat defaults to change',
    (s) => s.defaultAgentId === 'codex' && s.chatDocked,
  )
  await shot(page, 'chat')

  // Revoking trust means the dev script asks again next time.
  await page.getByRole('button', { name: 'Projects' }).click()
  expect((await page.evaluate(() => window.gui.getSettings())).trustedProjects).toContain(root)
  await shot(page, 'projects')
  await page.getByRole('button', { name: `Revoke trust for ${root}` }).click()
  await settingsWhere(page, 'trust to be revoked', (s) => !s.trustedProjects.includes(root))
})
