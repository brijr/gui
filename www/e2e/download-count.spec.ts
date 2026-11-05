import { expect, test } from '@playwright/test'

test('the home page shows the live download count next to Download for Mac', async ({ page }) => {
  await page.route('**/downloads', (route) => route.fulfill({ json: { downloads: 198 } }))
  await page.goto('/')
  const count = page.getByText('198 downloads', { exact: true })
  await expect(count).toBeVisible()
  await expect(page.getByRole('link', { name: 'Download for Mac', exact: true })).toBeVisible()
  const afterDownload = await page
    .getByRole('link', { name: 'Download for Mac', exact: true })
    .evaluate((link) => {
      const count = document.querySelector('[data-download-count]')
      if (!count || !link.parentElement) return false
      return (
        link.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING &&
        link.parentElement.contains(count)
      )
    })
  expect(afterDownload).toBe(true)
})

test('the home page hides the download count when the worker has none', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-download-count]')).toBeHidden()
  await expect(page.getByText('downloads')).toHaveCount(0)
})

test('the home page ignores extra fields on the download count', async ({ page }) => {
  await page.route('**/downloads', (route) =>
    route.fulfill({
      json: { downloads: 198, country: 'US', referrer: 'x.com', created_at: 1 },
    }),
  )
  await page.goto('/')
  await expect(page.locator('[data-download-count]')).toHaveText('198 downloads')
})
