import { expect, test } from '@playwright/test'

// /docs and /changelog: each renders, and the home page's footer links to both.

for (const [name, path, heading] of [
  ['Docs', '/docs', 'What you need'],
  ['Changelog', '/changelog', '0.1.0-alpha.1'],
] as const) {
  test(`the home page footer opens ${name}`, async ({ page }) => {
    await page.goto('/')
    await page.locator('footer').getByRole('link', { name, exact: true }).click()
    await expect(page).toHaveURL(`http://127.0.0.1:4329${path}`)
    await expect(page).toHaveTitle(`${name} — Gui`)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: heading, exact: true })).toBeVisible()
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
      'href',
      `https://usegui.com${path}`,
    )
    // Its own footer links back to the other page.
    const other = name === 'Docs' ? 'Changelog' : 'Docs'
    await expect(
      page.locator('footer').getByRole('link', { name: other, exact: true }),
    ).toBeVisible()
  })
}

test('the docs contents link to their sections', async ({ page }) => {
  await page.goto('/docs')
  const contents = page.getByRole('navigation', { name: 'On this page' })
  for (const link of await contents.getByRole('link').all()) {
    const id = (await link.getAttribute('href'))?.slice(1)
    await expect(page.locator(`h2[id="${id}"]`)).toHaveText((await link.innerText()).trim())
  }
})

test('the changelog lists the newest release first', async ({ page }) => {
  await page.goto('/changelog')
  const dates = await page
    .locator('.release time')
    .evaluateAll((times) => times.map((time) => time.getAttribute('datetime') ?? ''))
  expect(dates.length).toBeGreaterThan(1)
  expect(dates).toEqual(dates.toSorted().reverse())
})
