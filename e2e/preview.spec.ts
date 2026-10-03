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
