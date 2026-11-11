import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from './helpers/env'
import { devServerPids } from './helpers/processes'
import { expect, test } from './helpers/test'

// Opening a folder must never run its package.json scripts until the user has seen them. A
// project that was not trusted before shows a card, not a dialog, and stays idle until its
// button is pressed; nothing else (a stale card, the chat) agrees for the user.
test('an untrusted project runs nothing until its card agrees', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', trusted: false, open: 'recent' })
  await session.declineConsentDialogs()
  const { root, userData } = session.fixture

  await session.chrome.evaluate((path) => window.gui.openRecent(path), root)
  const consent = await session.consentCard()

  // A server that was going to start anyway would be starting or running by now.
  await sleep(5_000)

  // What runs is on the card, cleaned up, with the agent named too.
  expect(consent.changed).toBe(false)
  expect(consent.details).toContain('bun run dev')
  expect(consent.details).toContain('vite')
  expect(consent.details).toContain('.claude/settings.json')
  await expect(session.chrome.getByText(/^(Install and start|Start) gui-e2e/)).toBeVisible()
  await session.chrome.getByRole('button', { name: 'What runs' }).click()
  await session.shot('consent-card')

  const state = await session.state()
  expect(state.project?.devCommand).toBe('bun run dev')
  expect(state.devServer.status).toBe('idle')
  expect(state.devServer.url).toBeNull()
  expect(state.preview.visible).toBe(false)
  expect(devServerPids(root)).toEqual([])
  expect(existsSync(join(userData, 'trusted-projects.json'))).toBe(false)

  // An id the card didn't show agrees to nothing.
  await session.chrome.evaluate(() => window.gui.agreeToStart('not-the-card'))
  await sleep(1_000)
  expect((await session.state()).devServer.status).toBe('idle')
  expect(existsSync(join(userData, 'trusted-projects.json'))).toBe(false)

  // The button agrees: the project is trusted, what it runs kept, and it starts.
  await session.agreeOnCard()
  const running = await session.waitForPreview()
  expect(running.setup?.consent ?? null).toBeNull()
  const trusted: unknown = JSON.parse(readFileSync(join(userData, 'trusted-projects.json'), 'utf8'))
  expect(trusted).toEqual([root])
  const saved = JSON.parse(readFileSync(join(userData, 'trusted-scripts.json'), 'utf8'))
  expect(saved[root].starts['.']).toContain('vite')
  // No native dialog asked, at any point.
  expect(await session.consentPrompts()).toEqual([])
})
