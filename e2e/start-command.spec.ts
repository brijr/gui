import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from './helpers/env'
import { expect, test } from './helpers/test'

// A start that fails says so and offers the agent the job. When Gui runs the wrong thing, the
// user can tell it what starts the app instead, and it's remembered for the project.
test('a failed start offers the agent, and a start command set in Gui starts the app', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, userData } = session.fixture
  // The script Gui finds now crashes; the real server is there under another name.
  const file = join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.scripts = { dev: 'echo "Error: Cannot find module ./missing" && exit 1', 'dev:real': 'vite' }
  writeFileSync(file, JSON.stringify(pkg, null, 2))

  await session.chrome.evaluate((target) => window.gui.openRecent(target), root)
  const crashed = await waitFor(async () => {
    const state = await session.state()
    return state.devServer.status === 'exited' ? state : null
  }, 'the dev server to exit')
  expect(crashed.devServer.exitCode).toBe(1)
  expect(crashed.project?.custom).toBeNull()

  // The chat renders what agents write: it can't say what runs in the user's shell.
  await expect(
    session.chat.evaluate(() => window.gui.setStartCommand({ command: 'echo from-chat' })),
  ).rejects.toThrow(/only from Gui/)
  expect((await session.state()).project?.custom).toBeNull()

  // Not clicked: that would start a real agent turn.
  await expect(session.chrome.getByRole('button', { name: /^Fix with / }).first()).toBeVisible()
  await session.shot('crashed')

  await session.chrome.getByRole('button', { name: 'Change', exact: true }).click()
  const command = session.chrome.getByLabel('Dev server command')
  await expect(command).toHaveValue('bun run dev')
  await command.fill('bun run dev:real')
  await session.shot('start-command-form')
  await session.chrome.getByRole('button', { name: 'Save and start' }).click()

  // Until the old run is cleared away, the state still says it crashed.
  await waitFor(async () => {
    const { devServer } = await session.state()
    return devServer.command === 'bun run dev:real' && devServer.status !== 'exited'
  }, 'the app to start with the new command')
  const running = await session.waitForPreview()
  expect(running.project?.custom).toEqual({ command: 'bun run dev:real', dir: null, url: null })
  expect(running.devServer.command).toBe('bun run dev:real')

  // Kept in Gui's data, by the project's real path, never in the project.
  const saved = JSON.parse(readFileSync(join(userData, 'start-commands.json'), 'utf8'))
  expect(saved[root]).toEqual({ command: 'bun run dev:real', dir: null, url: null })
  expect(JSON.parse(readFileSync(file, 'utf8')).scripts.dev).toContain('exit 1')
})
