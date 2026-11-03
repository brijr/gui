import { randomBytes } from 'node:crypto'
import { constants, copyFile, link, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import { cleanName, frameId } from '../shared/board'
import type { BoardSession, IgnoredPage } from './board-session'
import type { BoardTools } from './mcp-board-tools'
import { describeBoard, type PromptBoard } from './prompt'

const BOARD_SHOT_MAX = { width: 1600, height: 1960 }
/**
 * Screenshots are JPEG: encoding runs on the main process, and PNG of a long page held the
 * whole app for half a second (stripe.com full page: PNG 557ms, JPEG 47ms). At 90, text and
 * gradients stay clean.
 */
const SHOT_QUALITY = 90

/** Scaled down to what the agent's image input takes. */
function fitForAgent(image: NativeImage) {
  const { width, height } = image.getSize()
  const scale = Math.min(1, BOARD_SHOT_MAX.width / width, BOARD_SHOT_MAX.height / height)
  const fitted =
    scale < 1
      ? image.resize({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          quality: 'good',
        })
      : image
  return { data: fitted.toJPEG(SHOT_QUALITY).toString('base64'), ...fitted.getSize() }
}

/** "Stripe Home.png" → "stripe-home.jpg": a plain file name, never a path. */
export function assetName(name: string) {
  const stem = name
    .trim()
    .replace(/\.(png|jpe?g)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${stem || 'screenshot'}.jpg`
}

/**
 * Canvas tool workflows depend on their board and its tab's callbacks. `live` is false once
 * the canvas closed: a tool call still in flight then changes nothing.
 */
export function createBoardTools(
  board: BoardSession,
  host: {
    prompt: () => PromptBoard | null
    open: (id: string | null) => Promise<void>
    live: () => boolean
    /** Aborts once the canvas closes */
    closed: AbortSignal
  },
): BoardTools {
  const tools = boardTools(board, host)
  const guarded = {} as Record<string, unknown>
  for (const [name, tool] of Object.entries(tools)) {
    guarded[name] = (...args: unknown[]) => {
      if (!host.live()) throw new Error('The canvas closed.')
      return (tool as (...args: unknown[]) => unknown)(...args)
    }
  }
  return guarded as unknown as BoardTools
}

/**
 * Saves `data` in `dir` as `name` (from `assetName`), or `name-2`, `name-3`… when that's
 * taken: never over another file, nor through a link planted at the name. Its final name.
 */
export async function saveAsset(dir: string, name: string, data: Buffer): Promise<string> {
  const stem = name.replace(/\.jpg$/, '')
  const temp = join(dir, `.${stem}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temp, data, { flag: 'wx' })
  try {
    for (let n = 1; n < 1000; n++) {
      const file = n === 1 ? name : `${stem}-${n}.jpg`
      try {
        // Both fail when the name is there, whatever it is: nothing is replaced.
        await link(temp, join(dir, file)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') throw error
          return copyFile(temp, join(dir, file), constants.COPYFILE_EXCL)
        })
        return file
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    throw new Error(`Too many files named ${stem} in assets/.`)
  } finally {
    await rm(temp, { force: true })
  }
}

/**
 * How canvas_list_frames tells the agent about pages that aren't on the board, so it can put
 * them there; nothing when there are none.
 */
export function describeIgnoredPages(pages: readonly IgnoredPage[], taken: ReadonlySet<string>) {
  const misnamed = pages.filter((page) => page.reason === 'name')
  const over = pages.filter((page) => page.reason === 'full')
  const lines: string[] = []
  if (misnamed.length) {
    const names = new Set(taken)
    lines.push(
      "These pages in frames/ are not on the canvas: a frame's file is named with lowercase letters, digits and dashes only, starting with a letter or digit (up to 64 characters), plus .html. Rename each to put it on the canvas:",
      ...misnamed.map((page) => {
        const id = frameId(page.file.replace(/\.html$/i, ''), names)
        names.add(id)
        return `- frames/${page.file} → frames/${id}.html`
      }),
    )
  }
  if (over.length)
    lines.push(
      `These pages in frames/ are not on the canvas because it already holds its most frames: ${over.map((page) => `frames/${page.file}`).join(', ')}.`,
    )
  return lines.join('\n')
}

function boardTools(
  board: BoardSession,
  host: {
    prompt: () => PromptBoard | null
    open: (id: string | null) => Promise<void>
    live: () => boolean
    /** Aborts once the canvas closes */
    closed: AbortSignal
  },
): BoardTools {
  const where = (frame: { id: string; width: number; height: number; x: number; y: number }) =>
    `frames/${frame.id}.html, ${frame.width}×${frame.height} at (${frame.x}, ${frame.y})`
  return {
    list: async () => {
      const listed = describeBoard(
        host.prompt() ?? { name: board.name, frames: [], selection: [], open: null },
      )
      const ignored = describeIgnoredPages(
        await board.ignoredPages(),
        new Set(board.frames.map((frame) => frame.id)),
      )
      return ignored ? `${listed}\n\n${ignored}` : listed
    },
    create: async ({ name, width, height, html, after }) => {
      const frame = await board.create({ name, width, height, html, after }, false)
      return `Created frame ${frame.id} "${frame.name}": ${where(frame)}.${html === undefined ? ' It has a placeholder page: write the whole page to that file.' : ''}`
    },
    duplicate: async (ids) => {
      const made = await board.duplicate(ids, false)
      if (!made.length) throw new Error('None of those frames are on the canvas.')
      return made.map((frame) => `Created ${frame.id} "${frame.name}": ${where(frame)}`).join('\n')
    },
    arrange: async (moves) => {
      const updates = moves.filter((move) => board.has(move.id))
      if (!updates.length) throw new Error('None of those frames are on the canvas.')
      await board.arrange(updates, false, false)
      return updates
        .map((update) => board.frame(update.id))
        .map((frame) => (frame ? `${frame.id}: ${where(frame)}` : ''))
        .join('\n')
    },
    rename: async (id, input) => {
      if (!board.has(id)) throw new Error(`There's no frame ${id}.`)
      const name = cleanName(input)
      if (!name) throw new Error("A frame's name can't be blank.")
      await board.rename(id, name, false)
      return `Renamed ${id} to "${board.frame(id)?.name ?? name}".`
    },
    remove: async (ids) => {
      const found = ids.filter((id) => board.has(id))
      if (!found.length) throw new Error('None of those frames are on the canvas.')
      await board.remove(found, false)
      return `Deleted ${found.join(', ')}.`
    },
    screenshot: async (id) => {
      if (!board.has(id)) throw new Error(`There's no frame ${id}.`)
      return fitForAgent(await board.screenshot(id))
    },
    screenshotUrl: async ({ saveAs, ...options }) => {
      // Loaded on first use: it starts browser windows, which the board itself never needs.
      const { captureWebPage, WEB_CAPTURE_MAX_HEIGHT } = await import('./web-capture')
      const shot = await captureWebPage(options, host.closed)
      if (!host.live()) throw new Error('The canvas closed.')
      let saved: string | null = null
      if (saveAs) {
        const assets = join(board.root, 'assets')
        await mkdir(assets, { recursive: true })
        saved = `assets/${await saveAsset(assets, assetName(saveAs), shot.image.toJPEG(SHOT_QUALITY))}`
      }
      return {
        ...fitForAgent(shot.image),
        url: shot.url,
        title: shot.title,
        pageHeight: shot.pageHeight,
        cutAt:
          options.fullPage && shot.pageHeight > WEB_CAPTURE_MAX_HEIGHT
            ? WEB_CAPTURE_MAX_HEIGHT
            : null,
        saved,
      }
    },
    open: async (id) => {
      if (id !== null && !board.has(id)) throw new Error(`There's no frame ${id}.`)
      await host.open(id)
      return id
        ? `Frame ${id} is open in the preview; the preview tools work on it.`
        : 'Back on the board.'
    },
    createSection: async (name, ids) => {
      const found = ids.filter((id) => board.has(id))
      if (!found.length) throw new Error('None of those frames are on the canvas.')
      const section = await board.addSection(found, name, false)
      if (!section) throw new Error("Couldn't make the section.")
      return `Created section ${section.id} "${section.name}" with ${section.frames.join(', ')}.`
    },
    updateSection: async (id, change) => {
      if (!board.section(id)) throw new Error(`There's no section ${id}.`)
      await board.updateSection(id, change, false)
      const section = board.section(id)
      return section
        ? `Section ${id} "${section.name}": ${section.frames.join(', ')}.`
        : `Section ${id} has no frames left, so it's gone.`
    },
    removeSection: async (id) => {
      if (!board.section(id)) throw new Error(`There's no section ${id}.`)
      await board.removeSection(id, false)
      return `Deleted section ${id}; its frames stay on the canvas.`
    },
  }
}
