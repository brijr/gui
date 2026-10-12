import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FRAME_MAX, FRAME_MIN } from '../shared/board'
import { failure, text } from './mcp-results'

/**
 * Tool names for a canvas (main/board-session.ts): its frames' layout is Gui's, so the
 * agent places, sizes, names and removes frames through these and writes their pages itself.
 * Only offered in a canvas's tab.
 */
export const BOARD_TOOL_NAMES = [
  'canvas_list_frames',
  'canvas_create_frame',
  'canvas_duplicate_frames',
  'canvas_arrange_frames',
  'canvas_rename_frame',
  'canvas_delete_frames',
  'canvas_screenshot',
  'canvas_open_frame',
] as const

export interface BoardTools {
  /** Every frame, its file, place and size, and which are selected and open */
  list: () => string
  create: (spec: {
    name: string
    width: number
    height: number
    html?: string
    after?: string[]
  }) => Promise<string>
  duplicate: (ids: string[]) => Promise<string>
  arrange: (
    moves: { id: string; x?: number; y?: number; width?: number; height?: number }[],
  ) => string
  rename: (id: string, name: string) => Promise<string>
  remove: (ids: string[]) => Promise<string>
  /** The frame rendered at its size: PNG, base64 */
  screenshot: (id: string) => Promise<{ data: string; width: number; height: number }>
  /** Shows the frame in the preview (null: back to the board) */
  open: (id: string | null) => Promise<string>
}

const frameIdSchema = z.string().min(1).max(64).describe('Frame id, as canvas_list_frames gives it')
const edge = z.number().int().min(FRAME_MIN).max(FRAME_MAX)

export function registerBoardTools(server: McpServer, board: BoardTools) {
  const run =
    <A>(task: (args: A) => Promise<string> | string) =>
    async (args: A) => {
      try {
        return text(await task(args))
      } catch (error) {
        return failure(error)
      }
    }

  server.registerTool(
    'canvas_list_frames',
    {
      title: 'List canvas frames',
      description:
        "The canvas's frames: each one's id, name, page file (relative to the canvas folder), position and size on the board in pixels, and which the user has selected or open. Read it before placing or editing frames.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    run(() => board.list()),
  )

  server.registerTool(
    'canvas_create_frame',
    {
      title: 'Create a canvas frame',
      description:
        'Adds a frame to the canvas and writes its page. Placed to the right of the frames in `after` (or of everything) without overlapping any frame. Pass the complete single-file HTML page in `html` (inline <style> and <script>; shared images go in assets/, referenced as ../assets/name), or omit it and write the returned file yourself. Name the frame for its idea ("Pricing — three tiers"). Desktop pages are usually 1440×900, tablet 820×1180, mobile 390×844.',
      inputSchema: {
        name: z.string().min(1).max(80).describe('Short name shown above the frame'),
        width: edge.describe('Page width in CSS pixels'),
        height: edge.describe('Frame height in CSS pixels (the page can scroll past it)'),
        html: z.string().max(2_000_000).optional().describe('The whole HTML page'),
        after: z
          .array(frameIdSchema)
          .max(20)
          .optional()
          .describe('Frames to place it beside, such as the one it varies'),
      },
    },
    run((spec) => board.create(spec)),
  )

  server.registerTool(
    'canvas_duplicate_frames',
    {
      title: 'Duplicate canvas frames',
      description:
        'Copies frames, pages included, placed beside the originals. Use it to start a variation from an existing frame, then edit the copy’s file.',
      inputSchema: { ids: z.array(frameIdSchema).min(1).max(20) },
    },
    run(({ ids }) => board.duplicate(ids)),
  )

  server.registerTool(
    'canvas_arrange_frames',
    {
      title: 'Move or resize canvas frames',
      description:
        'Moves frames on the board and/or changes their size. Give only what changes for each frame. Keep at least 80px between frames.',
      inputSchema: {
        frames: z
          .array(
            z.object({
              id: frameIdSchema,
              x: z.number().int().optional(),
              y: z.number().int().optional(),
              width: edge.optional(),
              height: edge.optional(),
            }),
          )
          .min(1)
          .max(60),
      },
    },
    run(({ frames }) => board.arrange(frames)),
  )

  server.registerTool(
    'canvas_rename_frame',
    {
      title: 'Rename a canvas frame',
      description: 'Changes the name shown above a frame. Its id and file stay the same.',
      inputSchema: { id: frameIdSchema, name: z.string().min(1).max(80) },
    },
    run(({ id, name }) => board.rename(id, name)),
  )

  server.registerTool(
    'canvas_delete_frames',
    {
      title: 'Delete canvas frames',
      description:
        'Removes frames from the canvas and deletes their pages. Only when the user asks for it.',
      inputSchema: { ids: z.array(frameIdSchema).min(1).max(60) },
      annotations: { destructiveHint: true },
    },
    run(({ ids }) => board.remove(ids)),
  )

  server.registerTool(
    'canvas_screenshot',
    {
      title: 'Screenshot a canvas frame',
      description:
        "A frame's page rendered at the frame's size, as the board shows it. Check every frame you create or change with it before replying.",
      inputSchema: { id: frameIdSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const shot = await board.screenshot(id)
        return {
          content: [
            { type: 'image' as const, data: shot.data, mimeType: 'image/png' },
            { type: 'text' as const, text: `Frame ${id} at ${shot.width}×${shot.height}` },
          ],
        }
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'canvas_open_frame',
    {
      title: 'Open a canvas frame in the preview',
      description:
        "Shows a frame's live page in the preview, where the preview_* tools (snapshot, click, type, inspect, console) work on it. Pass null to go back to the board.",
      inputSchema: { id: frameIdSchema.nullable() },
    },
    run(({ id }) => board.open(id)),
  )
}
