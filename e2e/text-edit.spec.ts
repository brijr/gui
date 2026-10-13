import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from './helpers/env'
import { expect, test } from './helpers/test'

// Double-clicking copy in the preview edits it in place (src/preload/preview.ts); Enter writes
// it to the source that rendered it, and hot reload shows it. Esc puts it back.

test('double-click edits page text in place and Enter writes it to the source', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const preview = await session.previewPage()
  const app = join(session.fixture.root, 'src/App.tsx')
  const heading = preview.locator('h1')

  // Esc: nothing changes, in the page or the source.
  await heading.dblclick()
  await expect(heading).toHaveAttribute('contenteditable', 'plaintext-only')
  await preview.keyboard.type('Thrown away')
  await preview.keyboard.press('Escape')
  await expect(heading).not.toHaveAttribute('contenteditable')
  await expect(heading).toHaveText('Gui Vite fixture')
  expect(readFileSync(app, 'utf8')).toContain('<h1>Gui Vite fixture</h1>')

  // Typing replaces the selected text; Enter keeps it.
  await heading.dblclick()
  await expect(heading).toHaveAttribute('contenteditable', 'plaintext-only')
  await preview.keyboard.type('Edited in place')
  await preview.keyboard.press('Enter')
  await expect(heading).not.toHaveAttribute('contenteditable')
  await waitFor(
    async () => readFileSync(app, 'utf8').includes('<h1>Edited in place</h1>'),
    'the source to be rewritten',
  )
  await expect(heading).toHaveText('Edited in place')
  // The page's React still owns the heading: it renders on as before.
  await preview.locator('button.counter').click()
  await expect(preview.locator('button.counter')).toHaveText('count is 1')
  await expect(heading).toHaveText('Edited in place')
})
