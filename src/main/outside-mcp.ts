import { createServer, type Server } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBoardTools } from './mcp-board-tools'
import { registerPreviewTools } from './mcp-preview-tools'
import { failure, type ToolServer, text } from './mcp-results'
import {
  answerMcp,
  bearerMatches,
  type GuiTool,
  MCP_SERVER_NAME,
  type McpBackends,
  type Sdk,
  sessionToolNames,
} from './mcp-server'

// Gui's tools for agents outside Gui (Claude Code, Codex, Cursor in the user's terminal or
// editor), the way a design app serves its canvas: one fixed address on loopback, a token the
// user copies from Settings, and each call acting on whatever is open in the focused Gui
// window. Off until the user turns it on (outside-agents.ts keeps the setting and the token).

/** Where other agents reach Gui: fixed, so the setup the user copies keeps working. */
export const OUTSIDE_MCP_PORT = 29_417
export const OUTSIDE_MCP_PATH = '/mcp'

/** Says which project or canvas the calls go to, for the agent to find its way first. */
export const STATUS_TOOL = 'gui_status'

/**
 * Every tool other agents get, by name: nothing else is ever served to them, so a new tool
 * stays Gui's own until it's added here. Left out, on purpose: what runs commands
 * (set_start_command, dev_server_restart), what reaches outside Gui (ASK_FIRST_TOOLS:
 * preview_open_website, canvas_screenshot_url), and what belongs to a chat (chat_turns, and
 * preview_variations, whose choice is sent to the chat's agent as a message).
 */
export const OUTSIDE_TOOL_NAMES = [
  STATUS_TOOL,
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
] as const satisfies readonly (GuiTool | typeof STATUS_TOOL)[]

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
  'Open a project or canvas in Gui: nothing is open in its focused window. Then call gui_status.'
export const CLOSED_MID_CALL =
  'The project or canvas closed in Gui while this ran. Open a project or canvas in Gui, then call gui_status.'

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

export const OUTSIDE_INSTRUCTIONS = `Gui is a Mac app for designing real interfaces. These tools act on what is open in the focused Gui window: a canvas or a project. Call gui_status first to see which, and again when the user switches.
A canvas is a board of frames; each frame is one HTML page (frames/<id>.html in the canvas folder). Place, size and remove frames with the canvas_ tools, and write their pages yourself.
In a project, the preview shows the user's app from its dev server.
The user watches the preview as you act. Screenshot (canvas_screenshot, preview_screenshot) to check your work.`

/** Gui's tools for other agents, for one request: acting on `target`, or on nothing. */
export function buildOutsideServer({ McpServer }: Sdk, target: OutsideTarget | null): McpServer {
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
    answerMcp(req, res, (sdk) => buildOutsideServer(sdk, target), allowedHosts)
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
