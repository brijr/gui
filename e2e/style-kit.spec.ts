import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { STYLE_KITS } from '../src/shared/style-kits'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// A style kit starts an empty canvas: its stylesheet and brand.md in assets/, and a sample frame.

const board = (session: GuiSession) =>
  waitFor(async () => (await session.state()).board, 'the canvas')

const undo = (session: GuiSession) =>
  session.app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Edit')
    edit?.submenu?.items.find((item) => item.label === 'Undo')?.click()
  })

test('a style kit starts an empty canvas, and No kit takes it away', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await chrome.getByRole('button', { name: /New canvas/ }).click()
  await board(session)
  const root = (await session.state()).project?.root ?? ''
  const sheet = join(root, 'assets', 'kit-neutral.css')
  const brand = join(root, 'assets', 'brand.md')

  await chrome.getByRole('button', { name: 'Use the Neutral kit' }).click()
  const frame = await waitFor(async () => {
    const { frames } = await board(session)
    return frames.length === 1 && frames[0].name === 'Neutral kit' ? frames[0] : null
  }, 'the kit frame')
  expect(existsSync(sheet)).toBe(true)
  expect(existsSync(brand)).toBe(true)

  // Live, the frame's page takes its background from the kit's stylesheet.
  await chrome.evaluate((id) => window.gui.boardOpenFrame(id), frame.id)
  const background = await waitFor(
    () =>
      session.app.evaluate(({ session: sessions, webContents }, id) => {
        const preview = sessions.fromPartition('persist:gui-preview')
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.session === preview && w.getURL().includes(`/frames/${id}.html`))
        // The kit's own value, resolved by the page, against what the body shows.
        return (
          wc?.executeJavaScript(`(() => {
            const probe = document.createElement('i')
            probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--background')
            document.body.append(probe)
            const kit = getComputedStyle(probe).color
            probe.remove()
            const body = getComputedStyle(document.body).backgroundColor
            return body === 'rgba(0, 0, 0, 0)' ? null : { kit, body }
          })()`) ?? null
        )
      }, frame.id),
    'the frame live with its kit',
  )
  expect(background.body).toBe(background.kit)
  expect(background.body).toBe('rgb(255, 255, 255)')
  expect(STYLE_KITS.find((kit) => kit.id === 'neutral')?.light['--background']).toBe('#ffffff')
  await chrome.getByRole('button', { name: 'Canvas', exact: true }).click()
  await waitFor(async () => (await session.state()).board?.open === null, 'back on the board')

  // Undo takes the frame away but leaves the kit; No kit takes that away too.
  await undo(session)
  await waitFor(async () => (await board(session)).frames.length === 0, 'the frame undone')
  await expect(chrome.getByText('Using the Neutral kit')).toBeVisible()
  await chrome.getByRole('button', { name: 'No kit', exact: true }).click()
  await waitFor(() => !existsSync(sheet) && !existsSync(brand), 'the kit files gone')
  await expect(chrome.getByText('Using the Neutral kit')).toBeHidden()
})
