import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent } from './helpers/tool-agent'

// A frame's Export submenu: the native menu and save dialog are stood in for.

/** Chooses Export > `label` from the frame's menu; the save dialog answers `file` and records its default name. */
async function exportAs(session: GuiSession, id: string, label: string, file: string) {
  await session.app.evaluate(
    ({ Menu, dialog }, { label, file }) => {
      const store = globalThis as unknown as { guiSaved?: string[] }
      store.guiSaved = []
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        store.guiSaved?.push((args.at(-1) as { defaultPath: string }).defaultPath)
        return { canceled: false, filePath: file }
      }) as unknown as typeof dialog.showSaveDialog
      const build = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = (template) => {
        const menu = build(template)
        const exporting = menu.items.find((item) => item.label === 'Export')
        if (exporting) {
          menu.popup = () => exporting.submenu?.items.find((item) => item.label === label)?.click()
          Menu.buildFromTemplate = build
        }
        return menu
      }
    },
    { label, file },
  )
  await session.chrome.evaluate((id) => window.gui.showFrameMenu(id), id)
  return waitFor(
    () => session.app.evaluate(() => (globalThis as unknown as { guiSaved: string[] }).guiSaved[0]),
    `the save dialog for ${label}`,
  )
}

test('a frame exports as one-page PDF and as a PNG named for its scale', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
  await installToolAgent(session)
  await ask(session, [
    {
      name: 'canvas_create_frame',
      args: { name: 'One', width: 1440, height: 900, html: '<!doctype html><h1>One</h1>' },
    },
  ])
  const pdf = join(tmpdir(), `gui-export-${Date.now()}.pdf`)
  expect(await exportAs(session, 'one', 'PDF', pdf)).toBe('one.pdf')
  const bytes = await waitFor(() => {
    try {
      return readFileSync(pdf, 'latin1')
    } catch {
      return null
    }
  }, 'the PDF written')
  expect(bytes.startsWith('%PDF')).toBe(true)
  expect(bytes.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(1)

  const png = join(tmpdir(), `gui-export-${Date.now()}.png`)
  expect(await exportAs(session, 'one', 'PNG 1×', png)).toBe('one@1x.png')
})
