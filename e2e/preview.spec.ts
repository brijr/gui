import { waitFor } from './helpers/env'
import { FIXTURES } from './helpers/fixtures'
import { expect, test } from './helpers/test'

const LOOPBACK_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/

// The first thing a user sees: open a project, the dev server starts without a prompt
// (the project is trusted), and the app shows up in the preview.
for (const fixture of FIXTURES) {
  test(`${fixture.name}: starts the dev server and shows the app`, async ({ launch }) => {
    const session = await launch({ fixture: fixture.name })
    const state = await session.waitForPreview()

    expect(state.project?.devCommand).toBe('bun run dev')
    expect(state.devServer.command).toBe('bun run dev')
    expect(state.devServer.url).toMatch(LOOPBACK_URL)
    expect(state.preview.url).toMatch(LOOPBACK_URL)
    expect(state.preview.error).toBeNull()
    // Element picking is only offered on local origins.
    expect(state.preview.selectable).toBe(true)

    const preview = await session.previewPage()
    await expect(preview.locator('h1')).toHaveText(fixture.heading, { timeout: 30_000 })
    await expect(preview.locator(fixture.selector)).toBeVisible()
    await session.shot('preview')
  })
}

// A stopped server's page no longer updates, so it doesn't pass for live: it's hidden, a dimmed
// picture of it stays under the card that says the app isn't running, and Start brings it back.
test('Stop dims the page under the card that starts the app again', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()

  await session.chrome.evaluate(() => window.gui.stopDevServer())
  const stopped = async () => {
    const { devServer, preview } = await session.state()
    return devServer.status === 'idle' && !preview.visible ? preview : null
  }
  const preview = await waitFor(stopped, 'the page to be hidden once stopped')
  expect(preview.still).toMatch(/^data:image\/jpeg;base64,/)
  expect(preview.selecting).toBe(false)
  await expect(session.chrome.locator('[data-preview-still]')).toBeVisible()
  await expect(session.chrome.getByText('Your app isn’t running')).toBeVisible()
  await session.shot('stopped')

  await session.chrome.getByRole('button', { name: 'Start dev server' }).click()
  const live = await session.waitForPreview()
  expect(live.preview.still).toBeNull()
  await expect(session.chrome.locator('[data-preview-still]')).toHaveCount(0)
})
