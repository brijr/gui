import type { BoardSession } from './board-session'
import type { BoardTools } from './mcp-board-tools'
import { describeBoard, type PromptBoard } from './prompt'

const BOARD_SHOT_MAX = { width: 1600, height: 1960 }

/** Canvas tool workflows depend on their board and two composition callbacks. */
export function createBoardTools(
  board: BoardSession,
  host: { prompt: () => PromptBoard | null; open: (id: string | null) => Promise<void> },
): BoardTools {
  const where = (frame: { id: string; width: number; height: number; x: number; y: number }) =>
    `frames/${frame.id}.html, ${frame.width}×${frame.height} at (${frame.x}, ${frame.y})`
  return {
    list: () =>
      describeBoard(host.prompt() ?? { name: board.name, frames: [], selection: [], open: null }),
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
    rename: async (id, name) => {
      if (!board.has(id)) throw new Error(`There's no frame ${id}.`)
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
      let image = await board.screenshot(id)
      const { width, height } = image.getSize()
      const scale = Math.min(1, BOARD_SHOT_MAX.width / width, BOARD_SHOT_MAX.height / height)
      if (scale < 1)
        image = image.resize({
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          quality: 'good',
        })
      const size = image.getSize()
      return { data: image.toPNG().toString('base64'), ...size }
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
