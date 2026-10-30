import { expect, type Page, test } from '@playwright/test'

test.use({ reducedMotion: 'reduce' })

async function tryYourself(page: Page) {
  await page.getByRole('button', { name: 'Try it now', exact: true }).click()
  await expect(page.locator('[data-demo]')).toHaveAttribute('data-state', 'intro')
  await page.getByRole('button', { name: 'Try it yourself', exact: true }).click()
  await expect(page.locator('[data-demo]')).toHaveAttribute('data-state', 'idle')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('launch demo explains its limits, skips the example, and accepts ordinary bold wording', async ({
  page,
}) => {
  await expect(page.getByText('The browser demo needs no account.')).toBeVisible()
  await tryYourself(page)
  await expect(
    page.getByText('Browser demo: bold, serif, or blue. No live AI agent.'),
  ).toBeVisible()
  await expect(page.locator('[data-transcript] .you')).toHaveCount(0)
  await page.locator('[data-demo-target]').click()
  const words = page.locator('[data-demo-target]')
  const before = await words.evaluate((el) => getComputedStyle(el).fontWeight)
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Make this bold.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('[data-demo]')).toHaveAttribute('data-state', 'idle')
  await expect(page.locator('[data-transcript] .you')).toHaveCount(1)
  await expect.poll(() => words.evaluate((el) => getComputedStyle(el).fontWeight)).not.toBe(before)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect.poll(() => words.evaluate((el) => getComputedStyle(el).fontWeight)).toBe(before)
})

test('launch demo Back returns to the same landing page', async ({ page }) => {
  await tryYourself(page)
  await page.goBack()
  await expect(page.locator('[data-demo]')).toBeHidden()
  await expect(page).toHaveURL('http://127.0.0.1:4329/')
  await page.goForward()
  await expect(page.getByRole('dialog', { name: 'Gui demo' })).toBeVisible()
})

test('launch waitlist survives a double click and Back dismisses only the dialog', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Sign up for the waitlist', exact: true }).dblclick()
  await expect(page.getByRole('dialog', { name: 'Gui for Windows and Linux' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('dialog', { name: 'Gui for Windows and Linux' })).toBeHidden()
  await expect(page).toHaveURL('http://127.0.0.1:4329/')
  await page.goForward()
  await expect(page.getByRole('dialog', { name: 'Gui for Windows and Linux' })).toBeVisible()
})

test('launch waitlist drops a late submission after closing and reopening', async ({ page }) => {
  let submitted = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/waitlist', async (route) => {
    submitted++
    await gate
    await route.fulfill({ json: { ok: true } })
  })
  await page.getByRole('button', { name: 'Sign up for the waitlist', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Gui for Windows and Linux' })
  await dialog.getByRole('textbox', { name: 'Email', exact: true }).fill('qa@example.invalid')
  await dialog.getByRole('button', { name: 'Sign up', exact: true }).click()
  await expect.poll(() => submitted).toBe(1)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page).toHaveURL('http://127.0.0.1:4329/')
  await page.getByRole('button', { name: 'Sign up for the waitlist', exact: true }).click()
  release()
  await expect(dialog.locator('[data-waitlist-done]')).toBeHidden()
  await expect(dialog.getByRole('button', { name: 'Sign up', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Sign up', exact: true }).click()
  await expect(dialog.locator('[data-waitlist-done]')).toBeVisible()
  expect(submitted).toBe(2)
})

test('launch mobile preview keeps text readable and actions fit a finger', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await tryYourself(page)
  const scale = await page
    .locator('[data-page]')
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
  expect(scale).toBeGreaterThan(0.85)
  await page.locator('[data-demo-target]').click()
  for (const button of await page.locator('[data-suggestion]').all()) {
    const hit = await button.evaluate((el) => {
      const style = getComputedStyle(el, '::before')
      return { height: parseFloat(style.height), width: parseFloat(style.width) }
    })
    expect(hit.height).toBeGreaterThanOrEqual(44)
    expect(hit.width).toBeGreaterThanOrEqual(44)
  }
  await page.locator('[data-desk]').dispatchEvent('click')
  await expect(page.locator('[data-demo]')).toHaveAttribute('data-state', 'idle')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375)
})

test('launch reduced motion keeps the video, spinner, and working timer still', async ({
  page,
}) => {
  await expect(page.locator('[data-hero-video]')).toHaveJSProperty('currentTime', 0)
  await expect(page.locator('.spinner').first()).toHaveCSS('animation-name', 'none')
  const timer = page.locator('[data-timer]').first()
  await timer.scrollIntoViewIfNeeded()
  const seconds = await timer.innerText()
  await page.waitForTimeout(1100)
  await expect(timer).toHaveText(seconds)
})
