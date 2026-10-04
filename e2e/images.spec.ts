import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, ImageAttachment, Turn } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import { gitStatus } from './helpers/fixtures'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Real agent turns spend usage on the developer's own login, so they only run on request.
const requested = process.env.GUI_E2E_AGENT || undefined
const TURN_TIMEOUT = 5 * 60_000

interface SolidImage {
  name: string
  width: number
  height: number
  color: string
}

/**
 * Runs in the chat page: a solid-color PNG with a WebP thumbnail, shaped like what the
 * composer sends.
 */
async function solidImage({ name, width, height, color }: SolidImage): Promise<ImageAttachment> {
  const encode = async (w: number, h: number, type: string) => {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d canvas is unavailable')
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    const blob = await canvas.convertToBlob({ type })
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }
  const scale = Math.min(1, 160 / Math.max(width, height))
  const png = await encode(width, height, 'image/png')
  const thumbnail = await encode(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
    'image/webp',
  )
  return { name, mimeType: 'image/png', data: png.split(',')[1] ?? '', thumbnail }
}

/** Runs in the chat page: sends whatever it's given, skipping the composer's own checks. */
function sendRaw({ text, images }: { text: string; images: unknown }) {
  return window.gui.send(text, images as ImageAttachment[])
}

/** Runs in the chat page: the pixel size of an image URL. */
async function imageSize(url: string) {
  const img = new Image()
  img.src = url
  await img.decode()
  return { width: img.naturalWidth, height: img.naturalHeight }
}

/**
 * Stops a turn while its agent is still starting, so no prompt reaches an agent and no
 * usage is spent (as in chat.spec.ts).
 */
async function cancelWhileStarting(session: GuiSession, index: number) {
  const started = async () => (await session.chatSnapshot()).turns.length > index
  await waitFor(started, `turn ${index + 1} to start`, { timeout: 10_000, interval: 25 })
  await session.chat.evaluate(() => window.gui.cancel())
  return session.waitForTurn(index, 30_000)
}

/** The project's saved chat history, once written. */
function savedHistory(userData: string): { text: string; turns: Turn[] } | null {
  const dir = join(userData, 'chats')
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((name) => /^[0-9a-f]+\.json$/.test(name))
  if (!file) return null
  const text = readFileSync(join(dir, file), 'utf8')
  return { text, turns: (JSON.parse(text) as { turns: Turn[] }).turns }
}

test('send validates images and keeps only thumbnails on the turn', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const { root, userData } = session.fixture

  const red = await session.chat.evaluate(solidImage, {
    name: 'red.png',
    width: 64,
    height: 64,
    color: '#ff0000',
  })

  // Main checks everything it's sent; a renderer bug can't push arbitrary data to the agent.
  const invalid: Record<string, unknown> = {
    'unsupported type': [{ ...red, mimeType: 'image/svg+xml' }],
    'data that is not base64': [{ ...red, data: 'not base64!' }],
    'a data: prefix on the data': [{ ...red, data: `data:image/png;base64,${red.data}` }],
    'a remote thumbnail': [{ ...red, thumbnail: 'https://example.com/thumb.png' }],
    'an SVG thumbnail': [{ ...red, thumbnail: 'data:image/svg+xml;base64,PHN2Zy8+' }],
    'an over-long name': [{ ...red, name: 'x'.repeat(201) }],
    'missing fields': [{ name: 'red.png' }],
    'more than six images': Array.from({ length: 7 }, () => red),
    'not an array': 'red.png',
  }
  for (const [label, images] of Object.entries(invalid)) {
    const sent = await session.chat.evaluate(sendRaw, { text: 'Match this.', images })
    expect.soft(sent, label).toBe(false)
  }
  const empty = await session.chat.evaluate(sendRaw, { text: '  ', images: [] })
  expect.soft(empty, 'no text and no images').toBe(false)
  expect((await session.chatSnapshot()).turns).toHaveLength(0)

  // An image alone is a message: main fills in the prompt the agent (and transcript) gets.
  const sent = await session.chat.evaluate(sendRaw, { text: '', images: [red] })
  expect(sent).toBe(true)
  const { turn, meta } = await cancelWhileStarting(session, 0)
  expect(turn.status).toBe('cancelled')
  expect(meta.error).toBeNull()
  expect(turn.prompt).toBe('Use the attached image as a reference.')
  expect(turn.attachments).toEqual([{ name: 'red.png', thumbnail: red.thumbnail }])
  expect(gitStatus(root)).toBe('')

  // History keeps the thumbnail and never the full image.
  const saved = await waitFor(() => {
    const history = savedHistory(userData)
    return history?.turns[0]?.status === 'cancelled' ? history : null
  }, 'the turn to be saved')
  expect(saved.turns[0]?.attachments).toEqual([{ name: 'red.png', thumbnail: red.thumbnail }])
  expect(saved.text).not.toContain(red.data)
})

test('the composer downscales, previews and sends attached images', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const { chat } = session

  const big = await chat.evaluate(solidImage, {
    name: 'big-red.png',
    width: 3000,
    height: 2000,
    color: '#ff0000',
  })
  const small = await chat.evaluate(solidImage, {
    name: 'small-blue.png',
    width: 40,
    height: 40,
    color: '#0000ff',
  })
  const file = ({ name, data }: ImageAttachment) => ({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(data, 'base64'),
  })
  const picker = chat.locator('input[type="file"]')

  // Non-images are refused quietly, next to the composer.
  await picker.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  })
  await expect(chat.getByRole('status')).toHaveText("notes.txt isn't an image.")

  await picker.setInputFiles([file(big), file(small)])
  const attached = chat.getByRole('list', { name: 'Attached images' })
  await expect(attached.getByRole('img', { name: 'big-red.png' })).toBeVisible()
  await expect(attached.getByRole('img', { name: 'small-blue.png' })).toBeVisible()
  await chat.getByRole('button', { name: 'Remove small-blue.png' }).click()
  await expect(attached.getByRole('img', { name: 'small-blue.png' })).toHaveCount(0)

  await chat.getByRole('textbox').fill('Make the counter look like this.')
  await chat.getByRole('button', { name: 'Send' }).click()
  const { turn } = await cancelWhileStarting(session, 0)
  expect(turn.status).toBe('cancelled')
  expect(turn.prompt).toBe('Make the counter look like this.')
  expect(turn.attachments?.map((image) => image.name)).toEqual(['big-red.png'])

  // The thumbnail is made from the image, scaled to a 160px long side.
  const thumbnail = turn.attachments?.[0]?.thumbnail ?? ''
  const size = await chat.evaluate(imageSize, thumbnail)
  expect(Math.max(size.width, size.height)).toBe(160)

  // Sent attachments leave the composer and show in the transcript instead.
  await expect(chat.getByRole('button', { name: 'Remove big-red.png' })).toHaveCount(0)
  await expect(chat.getByRole('img', { name: 'big-red.png' })).toBeVisible()
  await expect(chat.getByRole('textbox')).toHaveValue('')
})

/** Runs in the chat page: answers one permission prompt. */
function respond({
  turnId,
  itemId,
  optionId,
}: {
  turnId: string
  itemId: string
  optionId: string | null
}) {
  window.gui.respondPermission(turnId, itemId, optionId)
}

/**
 * Waits for a turn to end. The question needs no tools, so anything the agent asks to do
 * is declined; the project must stay untouched.
 */
async function finishTurn(session: GuiSession, index: number) {
  const deadline = Date.now() + TURN_TIMEOUT
  for (;;) {
    const { meta, turns } = await session.chatSnapshot()
    const turn = turns[index]
    if (turn && turn.status !== 'running') return turn
    if (meta.status === 'error' && meta.error) throw new Error(`Agent error: ${meta.error}`)
    for (const item of turn?.items ?? []) {
      if (item.kind !== 'permission' || item.resolved !== null) continue
      const reject = item.options.find((option) => option.kind.startsWith('reject'))
      await session.chat.evaluate(respond, {
        turnId: turn.id,
        itemId: item.id,
        optionId: reject?.optionId ?? null,
      })
    }
    if (Date.now() > deadline) throw new Error(`Turn ${index + 1} did not finish in time`)
    await sleep(1_000)
  }
}

test.describe('agent sees images', () => {
  test.skip(!requested, 'Set GUI_E2E_AGENT=claude|codex to run agent turns (spends real usage)')

  test('the agent can describe an attached image', async ({ launch }) => {
    test.setTimeout(10 * 60_000)
    const agentId: AgentId = requested === 'codex' ? 'codex' : 'claude'
    const session = await launch({ fixture: 'vite' })
    await session.waitForPreview()
    const { root } = session.fixture

    await session.chrome.evaluate((id) => window.gui.setAgent(id), agentId)
    const switched = async () => (await session.chatSnapshot()).meta.agentId === agentId
    await waitFor(switched, `the ${agentId} agent to be selected`)

    const red = await session.chat.evaluate(solidImage, {
      name: 'swatch.png',
      width: 256,
      height: 256,
      color: '#ff0000',
    })
    const prompt =
      'What is the dominant color of the attached image? Answer with the color name only. Do not change any files.'
    const sent = await session.chat.evaluate(sendRaw, { text: prompt, images: [red] })
    expect(sent).toBe(true)

    const turn = await finishTurn(session, 0)
    expect(turn.error, 'the agent reported an error').toBeNull()
    expect(turn.status).toBe('done')
    const notices = turn.items.flatMap((item) => (item.kind === 'notice' ? [item.text] : []))
    expect(notices.join('\n')).not.toContain("can't see images")
    const answer = turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
    expect(answer).toMatch(/\bred\b/i)
    expect(gitStatus(root)).toBe('')
  })
})
