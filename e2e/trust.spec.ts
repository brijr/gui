import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, waitFor } from './helpers/env'
import { devServerPids } from './helpers/processes'
import { expect, test } from './helpers/test'

// Opening a folder must never run its package.json scripts until the user has seen them.
// A project that was not trusted before has to stay idle, and declining must not trust it.
test('an untrusted project does not run its dev script', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', trusted: false, open: 'recent' })
  await session.declineConsentDialogs()
  const { root, userData } = session.fixture

  await session.chrome.evaluate((path) => window.grat.openRecent(path), root)
  const asked = async () => {
    const prompts = await session.consentPrompts()
    return prompts.length > 0 ? prompts : null
  }
  await waitFor(asked, 'the dev script consent prompt', { timeout: 30_000 })

  // A server that was going to start anyway would be starting or running by now.
  await sleep(5_000)

  const prompts = await session.consentPrompts()
  expect(prompts).toHaveLength(1)
  // The prompt names the project, and shows exactly what will run.
  expect(prompts[0]?.message).toMatch(/^Start .+\?$/)
  expect(prompts[0]?.detail).toContain('bun run dev')
  expect(prompts[0]?.detail).toContain('vite')

  const state = await session.state()
  expect(state.project?.devCommand).toBe('bun run dev')
  expect(state.devServer.status).toBe('idle')
  expect(state.devServer.url).toBeNull()
  expect(state.preview.visible).toBe(false)
  expect(devServerPids(root)).toEqual([])
  expect(existsSync(join(userData, 'trusted-projects.json'))).toBe(false)
})
