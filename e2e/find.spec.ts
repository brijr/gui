import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Edit → Find (⌘F) in the preview: a slim bar under the toolbar, Chromium's find in the page,
// and its count of matches; Find Next (⌘G) and Find Previous (⇧⌘G) step through them, Esc
// closes it. (A terminal with the keyboard gets its own bar; which one Find goes to is
// tests/find.test.ts's, as it needs Gui to be the active app.)

/** Clicks a visible item of the app menu by label, as tabs.spec.ts does. */
function clickMenu(session: GuiSession, label: string) {
  return session.app.evaluate(({ Menu }, name) => {
    type Item = Electron.MenuItem
    const find = (items: Item[]): Item | undefined => {
      for (const item of items) {
        if (item.label === name && item.visible) return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item) throw new Error(`No menu item "${name}"`)
    item.click()
  }, label)
}

test('Find in the preview counts the matches and steps through them', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const page = await session.previewPage()
  // Three of a word the page doesn't otherwise have.
  await page.evaluate(() => {
    const note = document.createElement('p')
    note.textContent = 'needle one, Needle two, and a NEEDLE three'
    document.body.append(note)
  })
  const bar = session.chrome.getByRole('search')
  const field = bar.getByRole('textbox', { name: 'Find in page' })
  const status = bar.getByRole('status')
  await expect(bar).toHaveCount(0)

  // Edit → Find…: the bar, with the keyboard in its field.
  await clickMenu(session, 'Find…')
  await expect(field).toBeVisible()
  await expect(field).toBeFocused()
  await field.fill('needle')
  await expect(status).toHaveText('1 of 3')
  await session.shot('find-in-page')

  // Find Next and Find Previous, from the menu, and ↩ and ⇧↩ in the field; around the ends.
  await clickMenu(session, 'Find Next')
  await expect(status).toHaveText('2 of 3')
  await field.press('Enter')
  await expect(status).toHaveText('3 of 3')
  await field.press('Enter')
  await expect(status).toHaveText('1 of 3')
  await clickMenu(session, 'Find Previous')
  await expect(status).toHaveText('3 of 3')
  await field.press('Shift+Enter')
  await expect(status).toHaveText('2 of 3')

  // Nothing found says so; the step buttons have nothing to step to.
  await field.fill('haystack')
  await expect(status).toHaveText('No matches')
  await expect(bar.getByRole('button', { name: 'Next match' })).toBeDisabled()

  // Esc closes it; ⌘F again brings it back with what was typed, selected to type over.
  await field.press('Escape')
  await expect(bar).toHaveCount(0)
  await clickMenu(session, 'Find…')
  await expect(field).toHaveValue('haystack')
  await expect(field).toBeFocused()
  await field.fill('fixture')
  await expect(status).toHaveText('1 of 1')
  await bar.getByRole('button', { name: 'Done' }).click()
  await expect(bar).toHaveCount(0)
})
