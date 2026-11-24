import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { imageSize } from '../src/main/image-size'
import { waitFor } from './helpers/env'
import { gitStatus } from './helpers/fixtures'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { installToolAgent, type ToolResult } from './helpers/tool-agent'

// A photo attached in a canvas's chat is also saved to the canvas's assets/ at full quality,
// with its metadata stripped, and the agent's prompt names the file; a project's chat writes
// nothing. A stand-in agent echoes the prompt it got: no agent login or paid usage.

const CAMERA = 'GuiTestCamera'

/** Runs in the chat page: a photo-like JPEG (a gradient), as base64. */
async function gradientJpeg({ width, height }: { width: number; height: number }) {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas is unavailable')
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, '#0ea5e9')
  gradient.addColorStop(1, '#f97316')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The JPEG with an EXIF block naming a camera, as a phone's photo carries one. */
function withExif(jpeg: Buffer) {
  const make = Buffer.from(`${CAMERA}\0`, 'latin1')
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4) // IFD0
  tiff.writeUInt16BE(1, 8) // one entry
  tiff.writeUInt16BE(0x010f, 10) // Make
  tiff.writeUInt16BE(2, 12) // ASCII
  tiff.writeUInt32BE(make.length, 14)
  tiff.writeUInt32BE(26, 18) // the string, after the IFD
  tiff.writeUInt32BE(0, 22) // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, make])
  const header = Buffer.from([0xff, 0xe1, 0, 0])
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)])
}

/** Sends `text` and the attached images through the composer; what the stand-in echoed. */
async function sendFromComposer(session: GuiSession, text: string): Promise<string[]> {
  const index = (await session.chatSnapshot()).turns.length
  await session.chat.getByRole('textbox').fill(text)
  await session.chat.getByRole('button', { name: 'Send' }).click()
  const { turn } = await session.waitForTurn(index)
  expect(turn.error).toBeNull()
  expect(turn.status).toBe('done')
  const [echo] = JSON.parse(
    turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join(''),
  ) as ToolResult[]
  return echo.content.map((item) => item.text ?? '')
}

const ECHO = `TOOLS ${JSON.stringify([{ context: '[Image ' }])}`

/** The same session driven through another tab's chat (each tab has its own). */
function withChat(session: GuiSession, chat: GuiSession['chat']): GuiSession {
  return Object.create(session, { chat: { value: chat } })
}

test("a photo sent in a canvas's chat is saved to its assets at full quality without metadata", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const photo = withExif(
    Buffer.from(await session.chat.evaluate(gradientJpeg, { width: 3000, height: 2000 }), 'base64'),
  )
  expect(photo.includes(CAMERA)).toBe(true)
  const file = (name: string) => ({ name, mimeType: 'image/jpeg', buffer: photo })

  // A project's chat: the prompt is as it was, and nothing is written to the user's repo.
  const projectRoot = session.fixture.root
  await installToolAgent(session)
  await session.chat.locator('input[type="file"]').setInputFiles(file('Beach Photo.jpg'))
  await expect(
    session.chat
      .getByRole('list', { name: 'Attached images' })
      .getByRole('img', { name: 'Beach Photo.jpg' }),
  ).toBeVisible()
  expect(await sendFromComposer(session, ECHO)).toEqual(['[Image 1] Beach Photo.jpg:'])
  expect(existsSync(join(projectRoot, 'assets'))).toBe(false)
  expect(gitStatus(projectRoot)).toBe('')

  // A canvas in a new tab.
  const first = (await session.state()).activeTab
  await session.chrome.evaluate(() => window.gui.newTab())
  await waitFor(async () => (await session.state()).activeTab !== first, 'the new tab')
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
  await waitFor(async () => (await session.state()).board, 'the canvas')
  const root = (await session.state()).project?.root ?? ''
  const chat = await waitFor(
    () =>
      session.app
        .context()
        .pages()
        .find((page) => page.url().endsWith('/chat.html') && page !== session.chat),
    "the canvas's chat",
  )
  const canvas = withChat(session, chat)
  await installToolAgent(canvas)

  // Two attached, one removed before sending: only the one sent is saved.
  await chat
    .locator('input[type="file"]')
    .setInputFiles([file('Beach Photo.jpg'), file('Not This One.jpg')])
  const attached = chat.getByRole('list', { name: 'Attached images' })
  await expect(attached.getByRole('img', { name: 'Not This One.jpg' })).toBeVisible()
  await chat.getByRole('button', { name: 'Remove Not This One.jpg' }).click()
  await expect(attached.getByRole('img', { name: 'Not This One.jpg' })).toHaveCount(0)
  await expect(attached.getByRole('img', { name: 'Beach Photo.jpg' })).toBeVisible()
  // Nothing is saved before the message goes (a new canvas's assets/ is empty).
  expect(readdirSync(join(root, 'assets'))).toEqual([])

  expect(await sendFromComposer(canvas, ECHO)).toEqual([
    '[Image 1] Beach Photo.jpg, saved as assets/beach-photo.jpg:',
  ])
  expect(readdirSync(join(root, 'assets'))).toEqual(['beach-photo.jpg'])
  const saved = readFileSync(join(root, 'assets', 'beach-photo.jpg'))
  // Full resolution (the agent's copy is 1568px at most), re-encoded with no EXIF.
  expect(imageSize(saved)).toEqual({ width: 3000, height: 2000 })
  expect(saved.includes('Exif')).toBe(false)
  expect(saved.includes(CAMERA)).toBe(false)
})
