import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachedAssetName,
  discardChatImages,
  isImageAsset,
  saveChatImages,
} from '../src/main/chat-image-assets'
import { buildPrompt } from '../src/main/prompt'
import type { ImageAttachment, SentImage } from '../src/shared/types'

// In a canvas's chat, an attached image is also saved to the canvas's assets/ at full quality
// and the agent is told the file, so it can put the real image in a frame. A project's chat
// writes nothing and its prompt is as it was.

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5])

const image = (name: string, extra: Partial<SentImage> = {}): SentImage => ({
  name,
  mimeType: 'image/jpeg',
  data: 'AAAA',
  thumbnail: 'data:image/png;base64,AAAA',
  ...extra,
})

const texts = (attachments: ImageAttachment[]) =>
  buildPrompt({
    text: 'Use this photo in the hero',
    selection: [],
    viewport: null,
    problems: [],
    preamble: false,
    tools: true,
    images: true,
    attachments,
  }).flatMap((block) => (block.type === 'text' ? [block.text] : []))

test('an attached image is saved under a plain name, in the format it was encoded in', () => {
  expect(attachedAssetName('Beach Photo.HEIC', 'image/jpeg')).toBe('beach-photo.jpg')
  expect(attachedAssetName('Screen Shot 2026-11-19 at 10.02.png', 'image/png')).toBe(
    'screen-shot-2026-11-19-at-10-02.png',
  )
  // A PNG photo too big to keep as PNG was sent as a JPEG.
  expect(attachedAssetName('render.png', 'image/jpeg')).toBe('render.jpg')
  expect(attachedAssetName('../../etc/passwd', 'image/png')).toBe('etc-passwd.png')
  expect(attachedAssetName('', 'image/jpeg')).toBe('image.jpg')
})

test('only a JPEG or PNG that says so in its bytes is taken as a copy to save', () => {
  expect(isImageAsset({ mimeType: 'image/jpeg', bytes: JPEG })).toBe(true)
  expect(isImageAsset({ mimeType: 'image/png', bytes: PNG })).toBe(true)
  expect(isImageAsset({ mimeType: 'image/png', bytes: JPEG })).toBe(false)
  expect(isImageAsset({ mimeType: 'image/gif', bytes: JPEG })).toBe(false)
  expect(isImageAsset({ mimeType: 'image/jpeg', bytes: new Uint8Array() })).toBe(false)
  expect(isImageAsset({ mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] })).toBe(false)
  expect(isImageAsset({ mimeType: 'image/jpeg', bytes: 'base64' })).toBe(false)
  expect(isImageAsset(null)).toBe(false)
})

test("a canvas's images are saved to assets/, never over a file there, and named for the agent", async () => {
  const root = await mkdtemp(join(tmpdir(), 'gui-chat-assets-'))
  try {
    const first = await saveChatImages(
      root,
      [
        image('Beach.jpg', { asset: { mimeType: 'image/jpeg', bytes: JPEG } }),
        image('Beach.jpg', { asset: { mimeType: 'image/jpeg', bytes: JPEG } }),
        image('logo.png', { mimeType: 'image/png', asset: { mimeType: 'image/png', bytes: PNG } }),
        // No copy came with it (it couldn't be made): it still goes, with no file.
        image('huge.jpg'),
      ],
      () => true,
    )
    expect(first.map((attached) => attached.saved)).toEqual([
      'assets/beach.jpg',
      'assets/beach-2.jpg',
      'assets/logo.png',
      undefined,
    ])
    // What goes on to the chat carries no bytes: only the agent's copy and the file's name.
    expect(first.every((attached) => !('asset' in attached))).toBe(true)
    expect(new Uint8Array(await readFile(join(root, 'assets', 'beach.jpg')))).toEqual(JPEG)
    expect(new Uint8Array(await readFile(join(root, 'assets', 'logo.png')))).toEqual(PNG)
    // The user's own file of that name stays theirs.
    await writeFile(join(root, 'assets', 'mine.jpg'), 'mine')
    const again = await saveChatImages(
      root,
      [image('mine.jpg', { asset: { mimeType: 'image/jpeg', bytes: JPEG } })],
      () => true,
    )
    expect(again[0]?.saved).toBe('assets/mine-2.jpg')
    expect(await readFile(join(root, 'assets', 'mine.jpg'), 'utf8')).toBe('mine')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('nothing is written once the canvas closed, and a failed save still sends the image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gui-chat-assets-'))
  try {
    const closed = await saveChatImages(
      root,
      [image('a.jpg', { asset: { mimeType: 'image/jpeg', bytes: JPEG } })],
      () => false,
    )
    expect(closed[0]?.saved).toBeUndefined()
    expect(await readdir(root)).toEqual([])
    // assets/ can't be made: a file is in the way.
    await writeFile(join(root, 'assets'), 'not a folder')
    const failed = await saveChatImages(
      root,
      [image('a.jpg', { asset: { mimeType: 'image/jpeg', bytes: JPEG } })],
      () => true,
    )
    expect(failed).toHaveLength(1)
    expect(failed[0]?.saved).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a canvas's prompt names the saved file and how a frame uses it", () => {
  const several = texts([image('beach.jpg', { saved: 'assets/beach.jpg' }), image('huge.jpg')])
  expect(several.slice(1)).toEqual([
    'The user attached 2 images, each labeled below in order. The message refers to an image by its label, such as [Image 1]. Each one saved to the canvas is named with its file; to use one in a frame, write <img src="../assets/<file>">.',
    '[Image 1] beach.jpg, saved as assets/beach.jpg:',
    '[Image 2] huge.jpg:',
  ])
})

test("a project's prompt, or an image that wasn't saved, names no path", () => {
  expect(texts([image('beach.jpg')]).slice(1)).toEqual([
    'The user attached an image, labeled below. The message refers to an image by its label, such as [Image 1].',
    '[Image 1] beach.jpg:',
  ])
  const several = buildPrompt({
    text: 'Is [Image 2] darker than [Image 1]?',
    selection: [],
    viewport: null,
    problems: [],
    preamble: false,
    tools: true,
    images: true,
    attachments: [image('a.jpg'), { ...image('b.jpg'), data: 'BBBB' }],
  })
  expect(several.slice(-4)).toEqual([
    { type: 'text', text: '[Image 1] a.jpg:' },
    { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
    { type: 'text', text: '[Image 2] b.jpg:' },
    { type: 'image', mimeType: 'image/jpeg', data: 'BBBB' },
  ])
  const blocks = buildPrompt({
    text: 'x',
    selection: [],
    viewport: null,
    problems: [],
    preamble: false,
    tools: true,
    images: true,
    attachments: [image('beach.jpg', { saved: 'assets/beach.jpg' })],
  })
  // The image itself still follows its line, as before.
  expect(blocks.at(-1)).toEqual({ type: 'image', mimeType: 'image/jpeg', data: 'AAAA' })
})

test("a message that didn't go takes its saved images back out of assets/", async () => {
  const root = await mkdtemp(join(tmpdir(), 'gui-chat-assets-'))
  try {
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'assets', 'mine.jpg'), 'mine')
    const saved = await saveChatImages(
      root,
      [image('a.jpg', { asset: { mimeType: 'image/jpeg', bytes: JPEG } }), image('b.jpg')],
      () => true,
    )
    // Only paths main itself names: never one outside assets/.
    await discardChatImages(root, [...saved, image('x.jpg', { saved: '../mine.jpg' })])
    expect(await readdir(join(root, 'assets'))).toEqual(['mine.jpg'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
