import { createServer, type Server } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerBoardTools } from './mcp-board-tools'
import { registerPreviewTools } from './mcp-preview-tools'
import { failure, type ToolServer, text, untrusted } from './mcp-results'
import {
  answerMcp,
  bearerMatches,
  type GuiTool,
  MCP_SERVER_NAME,
  type McpBackends,
  type Sdk,
  sessionToolNames,
} from './mcp-server'
import type { OpenRequest } from './outside-open'

// Gui's tools for agents outside Gui (Claude Code, Codex, Cursor in the user's terminal or
// editor), the way a design app serves its canvas: one fixed address on loopback, a token the
// user copies from Settings, and each call acting on whatever is open in the focused Gui
// window. Off until the user turns it on (outside-agents.ts keeps the setting and the token).

/** Where other agents reach Gui: fixed, so the setup the user copies keeps working. */
export const OUTSIDE_MCP_PORT = 29_417
export const OUTSIDE_MCP_PATH = '/mcp'

/** Says which project or canvas the calls go to, for the agent to find its way first. */
export const STATUS_TOOL = 'gui_status'
/** Lists Gui's recent projects and canvases; works with nothing open. */
export const LIST_TOOL = 'gui_list'
/** Opens one, without a chat (outside-open.ts); works with nothing open. */
export const OPEN_TOOL = 'gui_open'

/** Gui's own tools for other agents, beside the ones its own agents have. */
type OutsideOnly = typeof STATUS_TOOL | typeof LIST_TOOL | typeof OPEN_TOOL
/** These answer with nothing open: they're how the agent gets something open. */
const ANYWHERE: ReadonlySet<string> = new Set([LIST_TOOL, OPEN_TOOL])

/**
 * Every tool other agents get, by name: nothing else is ever served to them, so a new tool
 * stays Gui's own until it's added here. Left out, on purpose: what runs commands
 * (set_start_command, dev_server_restart), what reaches outside Gui (ASK_FIRST_TOOLS:
 * preview_open_website, canvas_screenshot_url), and what belongs to a chat (chat_turns, and
 * preview_variations, whose choice is sent to the chat's agent as a message).
 */
export const OUTSIDE_TOOL_NAMES = [
  STATUS_TOOL,
  LIST_TOOL,
  OPEN_TOOL,
  'preview_screenshot',
  'preview_snapshot',
  'preview_inspect',
  'preview_console',
  'preview_motion',
  'preview_click',
  'preview_hover',
  'preview_type',
  'preview_press',
  'preview_scroll',
  'preview_wait',
  'preview_point',
  'preview_guides',
  'preview_navigate',
  'preview_back',
  'preview_reload',
  'dev_server_logs',
  'recording_frames',
  'recording_timeline',
  'recording_narration',
  'canvas_list_frames',
  'canvas_create_frame',
  'canvas_duplicate_frames',
  'canvas_arrange_frames',
  'canvas_delete_frames',
  'canvas_screenshot',
  'canvas_open_frame',
  'canvas_section',
] as const satisfies readonly (GuiTool | OutsideOnly)[]

const OUTSIDE: ReadonlySet<string> = new Set(OUTSIDE_TOOL_NAMES)

/** What the calls act on: the project or canvas open in the focused Gui window, as it is now. */
export interface OutsideTarget {
  kind: 'canvas' | 'project'
  name: string
  /** Its folder */
  root: string
  /** The preview (and a project's dev server), in a line or two */
  preview: () => string
  /** False once this opening has closed or been replaced (ProjectResources `stillCurrent`) */
  live: () => boolean
  /** Aborts as the opening closes */
  closed: AbortSignal
  backends: Pick<McpBackends, 'tools' | 'recordings' | 'board'>
  /**
   * A call finished. What Gui does when its own agent's turn ends: a walkthrough's pointer
   * stays a moment, then goes.
   */
  settled?: () => void
}

export const NOTHING_OPEN =
  "Nothing is open in Gui's front window. gui_list lists Gui's projects and canvases; gui_open opens one."
export const CLOSED_MID_CALL =
  'The project or canvas closed in Gui while this ran. gui_status says what is open now; gui_open opens another.'

/** A recent project or canvas, for gui_list. */
export interface OutsidePlace {
  kind: 'canvas' | 'project'
  name: string
  folder: string
  /** A canvas's id, for gui_open */
  id?: string
}

/** Opens what the agent asks for, and lists what it can ask for (index.ts, outside-open.ts). */
export interface OutsideOpener {
  list(): Promise<OutsidePlace[]>
  /** Resolves with what the calls act on now; rejects with why it didn't open */
  open(request: OpenRequest): Promise<OutsideTarget>
}

/** The tools that work on a canvas, and those that work in a project. */
const AVAILABLE = {
  canvas: new Set<string>([STATUS_TOOL, ...sessionToolNames(true)]),
  project: new Set<string>([STATUS_TOOL, ...sessionToolNames(false)]),
} as const

const quoted = (name: string) => `“${name.replace(/\s+/g, ' ').slice(0, 120)}”`

function wrongKind(tool: string, target: OutsideTarget) {
  const needs = target.kind === 'canvas' ? 'a project' : 'a canvas'
  return `${tool} works in ${needs}; the focused Gui window has the ${target.kind} ${quoted(target.name)} open.`
}

/** Stands in for an opening's tools when there is none: the guard never lets a call reach it. */
const nothing = new Proxy(
  {},
  {
    get() {
      throw new Error(NOTHING_OPEN)
    },
  },
) as never

type Callback = (...args: unknown[]) => unknown

/**
 * Runs `callback` for the opening the call came in for, and only while it lasts: an error
 * when nothing is open or the tool is for the other kind, and CLOSED_MID_CALL when the opening
 * closes before it answers (its work stops on its own, at its next `live` check).
 */
function guard(name: string, target: OutsideTarget | null, callback: Callback): Callback {
  if (ANYWHERE.has(name)) return callback
  return async (...args) => {
    if (!target) return failure(NOTHING_OPEN)
    if (!target.live()) return failure(CLOSED_MID_CALL)
    if (!AVAILABLE[target.kind].has(name)) return failure(wrongKind(name, target))
    let stop = () => {}
    const closed = new Promise<null>((resolve) => {
      const onAbort = () => resolve(null)
      target.closed.addEventListener('abort', onAbort, { once: true })
      stop = () => target.closed.removeEventListener('abort', onAbort)
    })
    try {
      const result = await Promise.race([
        Promise.resolve()
          .then(() => callback(...args))
          .catch(failure),
        closed,
      ])
      return result !== null && target.live() ? result : failure(CLOSED_MID_CALL)
    } finally {
      stop()
      if (target.live()) target.settled?.()
    }
  }
}

/** Registers only the allowlisted tools on `server`, each guarded for `target`. */
function allowlisted(server: McpServer, target: OutsideTarget | null): ToolServer {
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: unknown,
    callback: Callback,
  ) => unknown
  return {
    registerTool: ((name: string, config: unknown, callback: Callback) =>
      OUTSIDE.has(name)
        ? register(name, config, guard(name, target, callback))
        : undefined) as unknown as McpServer['registerTool'],
  }
}

/** gui_status: where the calls go now. */
export function describeTarget(target: OutsideTarget) {
  const lines = [
    `Calls act on the ${target.kind} ${quoted(target.name)}, open in the focused Gui window.`,
    `Folder: ${target.root}`,
  ]
  if (target.kind === 'canvas')
    lines.push(
      'Each frame is one HTML page in frames/ (shared images in assets/, referenced as ../assets/name). canvas_list_frames lists them.',
    )
  lines.push(target.preview())
  return lines.join('\n')
}

export const OUTSIDE_INSTRUCTIONS = `Gui is a Mac app for designing real interfaces. These tools act on what is open in the focused Gui window: a canvas or a project. Call gui_status first to see which, and again when the user switches. With nothing open, gui_list lists Gui's projects and canvases and gui_open opens one.
A canvas is a board of frames; each frame is one HTML page (frames/<id>.html in the canvas folder). Place, size and remove frames with the canvas_ tools, and write their pages yourself.
In a project, the preview shows the user's app from its dev server.
The user watches the preview as you act. Screenshot (canvas_screenshot, preview_screenshot) to check your work.`

/** Gui's tools for other agents, for one request: acting on `target`, or on nothing. */
export function buildOutsideServer(
  { McpServer }: Sdk,
  target: OutsideTarget | null,
  opener: OutsideOpener,
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: '0.2.0' },
    { instructions: OUTSIDE_INSTRUCTIONS },
  )
  const tools = allowlisted(server, target)
  tools.registerTool(
    STATUS_TOOL,
    {
      title: 'See what Gui has open',
      description:
        'Which project or canvas the other Gui tools act on (the one in the focused Gui window): its name, whether it is a canvas or a project, its folder, and what the preview shows (a project: whether its dev server is up). Call it first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    // The guard answers NOTHING_OPEN when there's no target.
    async () => text(target ? describeTarget(target) : NOTHING_OPEN),
  )
  tools.registerTool(
    LIST_TOOL,
    {
      title: "List Gui's projects and canvases",
      description:
        "Gui's recent canvases (id, name, folder) and projects (name, folder), and which one the other tools act on now (`current`, null with nothing open). Open one with gui_open.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const current = target?.live() ? target.root : null
        const places = (await opener.list()).map((place) => ({
          ...place,
          current: place.folder === current,
        }))
        return untrusted(
          'gui_list',
          JSON.stringify({
            current: target?.live()
              ? { kind: target.kind, name: target.name, folder: target.root }
              : null,
            canvases: places.filter((place) => place.kind === 'canvas'),
            projects: places.filter((place) => place.kind === 'project'),
          }),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )
  tools.registerTool(
    OPEN_TOOL,
    {
      title: 'Open a project or canvas in Gui',
      description:
        "Opens a canvas (by `canvas` id, or its `folder`) or a project (by its `folder`, a full path) in Gui's front window, where the user sees it, and the other tools act on it from then on. It opens without Gui's chat. A folder Gui has never opened asks the user first, in Gui, and fails if they decline. Returns what gui_status returns.",
      inputSchema: {
        canvas: z.string().min(1).max(64).optional().describe('Canvas id, as gui_list gives it'),
        folder: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("A project's or canvas's folder: its full path"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ canvas, folder }: { canvas?: string; folder?: string }) => {
      if ((canvas === undefined) === (folder === undefined))
        return failure(new Error('Pass `canvas` or `folder`, one of them.'))
      try {
        const opened = await opener.open(
          canvas !== undefined ? { canvas } : { folder: folder ?? '' },
        )
        return text(describeTarget(opened))
      } catch (error) {
        return failure(error)
      }
    },
  )
  // Project descriptions (a canvas's tools say where they differ); never preview_open_website.
  registerPreviewTools(
    tools,
    target?.backends.tools ?? nothing,
    target?.backends.recordings ?? nothing,
    true,
    false,
  )
  registerBoardTools(tools, target?.backends.board ?? nothing)
  return server
}

export interface OutsideServerOptions {
  port: number
  /** The token callers must send; null lets none in */
  token: () => string | null
  /** Only while the user is signed in to Gui (where Gui requires an account) */
  signedIn: () => boolean
  /** The opening in the focused Gui window, looked up as each call comes in */
  target: () => OutsideTarget | null
  opener: OutsideOpener
}

export interface RunningOutsideServer {
  close(): void
}

const SIGN_IN = 'Sign in to Gui to use its tools.'

/**
 * Serves Gui's tools to other agents at `port` on loopback, statelessly, behind the user's
 * token, as Gui's own server does for its agents (mcp-server.ts). Rejects if the port is taken.
 */
export async function startOutsideMcpServer(
  options: OutsideServerOptions,
): Promise<RunningOutsideServer> {
  const { port } = options
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  const http: Server = createServer((req, res) => {
    if (req.url !== OUTSIDE_MCP_PATH) {
      res.writeHead(404).end()
      return
    }
    const token = options.token()
    if (!token || !bearerMatches(req.headers.authorization, token)) {
      res.writeHead(401).end()
      return
    }
    if (!options.signedIn()) {
      res
        .writeHead(401, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: SIGN_IN } }),
        )
      return
    }
    // Looked up as the call comes in, never kept: the next call finds what's focused then.
    const target = options.target()
    answerMcp(req, res, (sdk) => buildOutsideServer(sdk, target, options.opener), allowedHosts)
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  http.on('error', (error) => console.error('[gui] outside MCP server failed', error))

  return {
    close: () => {
      http.close()
      http.closeAllConnections()
    },
  }
}
