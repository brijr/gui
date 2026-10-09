import { expect, test } from '@playwright/test'

// Not part of the suite: screenshots of each step for review, in test-results/shots.
// SHOTS=1 bunx playwright test e2e/shots.spec.ts
test.skip(!process.env.SHOTS, 'screenshots only on request')
for (const [name, viewport, scheme] of [
  ['desktop-light', { width: 1440, height: 900 }, 'light'],
  ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
  ['laptop', { width: 1280, height: 720 }, 'light'],
  ['phone', { width: 390, height: 844 }, 'light'],
] as const) {
  test(name, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('/')
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: 'Try it now' }).click()
    for (const t of [120, 300, 500]) {
      await page.waitForTimeout(t === 120 ? 120 : t === 300 ? 180 : 200)
      await page.screenshot({ path: `test-results/shots/${name}-open-${t}.png` })
    }
    await page.waitForTimeout(6500)
    await page.screenshot({ path: `test-results/shots/${name}-mid.png` })
    await expect(page.locator('[data-demo]')).toHaveAttribute('data-state', 'idle', {
      timeout: 40000,
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `test-results/shots/${name}-idle.png` })
  })
}
