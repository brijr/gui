import { join } from 'node:path'
import { ClipboardItem, clipboard } from 'electron'
import {
  type CopiedFrames,
  copiedFramesText,
  FRAMES_MIME,
  parseCopiedFrames,
} from '../shared/board-clipboard'
import { MAX_COPIED_FRAMES_BYTES } from '../shared/bounded'
import { boardRoot, isBoardId } from './board'
import type { BoardSession } from './board-session'

/*
 * Canvas frames on the system clipboard, so ⌘V pastes them on any canvas, in this window or
 * another. Gui's own format, with a PNG beside it when one frame is copied, for other apps.
 */

/** The last copy, still being written: a paste right after it waits for it. */
let writing: Promise<unknown> = Promise.resolve()

/**
 * `ids` on the clipboard; with `image`, one frame's picture too (at `scale`), which a cut
 * skips, as the page goes before it could be drawn. False when there was nothing to copy.
 */
export async function copyFrames(
  board: BoardSession,
  ids: string[],
  { image, scale }: { image: boolean; scale: number },
): Promise<boolean> {
  const frames = await board.copyable(ids)
  if (!frames.length) return false
  const text = copiedFramesText(board.id, frames)
  if (Buffer.byteLength(text) > MAX_COPIED_FRAMES_BYTES)
    throw new Error('These frames are too big to copy together. Copy fewer at a time.')
  const write = (async () => {
    const png =
      image && frames.length === 1
        ? await board
            .screenshot(frames[0].id, scale)
            .then((shot) => shot.toPNG())
            .catch(() => null)
        : null
    const types: Record<string, string | Blob> = { [FRAMES_MIME]: text }
    if (png) types['image/png'] = new Blob([new Uint8Array(png)], { type: 'image/png' })
    await clipboard.write([new ClipboardItem(types)])
  })()
  writing = write.catch(() => undefined)
  await write
  return true
}

/**
 * The frames on the clipboard, and the folder of shared files their pages use (on the canvas
 * they came from); null when what's there isn't frames.
 */
export async function pastedFrames(): Promise<{
  copied: CopiedFrames
  assets: string | null
} | null> {
  await writing
  const items = await clipboard.read()
  const item = items.find((entry) => entry.types.includes(FRAMES_MIME))
  if (!item) return null
  const blob = await item.getType(FRAMES_MIME)
  if (!(blob instanceof Blob) || blob.size > MAX_COPIED_FRAMES_BYTES) return null
  const copied = parseCopiedFrames(await blob.text())
  if (!copied) return null
  return {
    copied,
    assets: isBoardId(copied.canvas) ? join(boardRoot(copied.canvas), 'assets') : null,
  }
}
