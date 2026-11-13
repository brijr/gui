import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { APP_TOOL_TITLES, type AppTools, registerAppTools } from './mcp-app-tools'
import { BOARD_TOOL_TITLES, type BoardTools, registerBoardTools } from './mcp-board-tools'
import { PREVIEW_TOOL_TITLES, previewToolNames, registerPreviewTools } from './mcp-preview-tools'
import type { PreviewTools } from './preview-tools'
import type { Recordings } from './recordings'

export const MCP_SERVER_NAME = 'gui'

/**
 * Every tool Gui exposes, with the title it registers under: the preview's
 * (mcp-preview-tools.ts), Gui's own (mcp-app-tools.ts) and, in a canvas, the canvas's
 * (mcp-board-tools.ts). The chat labels each call with its title (chat-tools.ts).
 */
export const GUI_TOOL_TITLES = {
  ...PREVIEW_TOOL_TITLES,
  ...APP_TOOL_TITLES,
  ...BOARD_TOOL_TITLES,
} as const

export type GuiTool = keyof typeof GUI_TOOL_TITLES

export const GUI_TOOL_NAMES = Object.keys(GUI_TOOL_TITLES) as GuiTool[]

/**
 * The tools a session lists: a project's, or a canvas's (no dev server, websites or rulers).
 * Without `websites`, no preview_open_website (`previewToolNames`).
 */
export function sessionToolNames(canvas: boolean, websites = true): GuiTool[] {
  return [
    ...previewToolNames(!canvas, websites),
    ...(Object.keys(APP_TOOL_TITLES) as GuiTool[]),
    ...(canvas ? (Object.keys(BOARD_TOOL_TITLES) as GuiTool[]) : []),
  ]
}

/**
 * Gui's tools that reach outside Gui (loading any website): a page's address can carry data
 * out, so the user decides each call. Claude isn't allowed them up front (agent.ts), and Gui
 * never answers a request for one by itself, in Auto mode either (chat.ts).
 */
export const ASK_FIRST_TOOLS: ReadonlySet<string> = new Set<GuiTool>([
  'preview_open_website',
  'canvas_screenshot_url',
])

interface Sdk {
  McpServer: typeof McpServer
  StreamableHTTPServerTransport: typeof StreamableHTTPServerTransport
}

let sdk: Promise<Sdk> | null = null

/** Sees every JSON-RPC message an agent sends to the server; only dev builds set one (dev-flags.ts). */
let observer: ((message: unknown) => void) | null = null

/** Reports each message agents send Gui's MCP servers to `observe`, from now on. */
export function observeMcpRequests(observe: (message: unknown) => void) {
  observer = observe
}

/** The request's JSON body, or undefined when it isn't JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * The MCP SDK, loaded when an agent first calls a tool (or just after the first window
 * shows, by `preloadMcpSdk`) rather than before the first window or while a project opens:
 * it holds the main thread for tens of milliseconds as it loads.
 */
function loadSdk(): Promise<Sdk> {
  sdk ??= Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
  ]).then(
    ([mcp, http]) => ({
      McpServer: mcp.McpServer,
      StreamableHTTPServerTransport: http.StreamableHTTPServerTransport,
    }),
    (error: unknown) => {
      // The next project tries again.
      sdk = null
      throw error
    },
  )
  return sdk
}

/** Loads the SDK ahead of the first project, once Gui is idle. */
export function preloadMcpSdk() {
  loadSdk().catch((error: unknown) => console.error('[gui] MCP SDK failed to load', error))
}

function buildServer(
  { McpServer }: Sdk,
  tools: PreviewTools,
  recordings: Recordings,
  app: AppTools,
  board: BoardTools | null,
  websites: boolean,
) {
  const server = new McpServer({ name: 'gui', version: '0.2.0' })
  registerPreviewTools(server, tools, recordings, board === null, websites)
  registerAppTools(server, app)
  if (board) registerBoardTools(server, board)
  return server
}

export interface RunningMcpServer {
  /**
   * Ready to pass in ACP `session/new` / `session/load`. Without `websites`, the session
   * can't open one (`previewToolNames`).
   */
  config(websites?: boolean): AcpMcpServer
  close(): void
}

/** Where a session's tools are served: the same tools but preview_open_website at the second. */
const PATHS = { websites: '/mcp', noWebsites: '/mcp/no-websites' } as const

/**
 * Serves Gui's tools over MCP Streamable HTTP on loopback, stateless, behind a bearer token
 * made for this opening of the project, so only the agent sessions it starts can call them.
 * A new McpServer and transport answer each request: the SDK's server holds one transport
 * at a time, and stateless calls arrive in parallel, so one shared server would cross their
 * replies.
 */
export async function startMcpServer(
  tools: PreviewTools,
  recordings: Recordings,
  app: AppTools,
  board: BoardTools | null = null,
): Promise<RunningMcpServer> {
  const token = randomBytes(24).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const authorized = (header: string | undefined) => {
    const given = Buffer.from(header ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  let allowedHosts: string[] = []
  const http: Server = createServer((req, res) => {
    const websites = req.url === PATHS.websites
    if ((!websites && req.url !== PATHS.noWebsites) || !authorized(req.headers.authorization)) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream to resume.
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    // The server listens without the SDK, so a project opening doesn't wait for it to load;
    // the first call does, if it comes before `preloadMcpSdk` has.
    loadSdk()
      .then((loaded) => {
        // Hung up while the SDK loaded: nothing to answer, and no `close` left to wait for.
        if (res.destroyed) return
        const server = buildServer(loaded, tools, recordings, app, board, websites)
        const transport = new loaded.StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
          allowedHosts,
          enableDnsRebindingProtection: true,
        })
        res.on('close', () => {
          void transport.close()
          void server.close()
        })
        if (!observer) {
          return server.connect(transport).then(() => transport.handleRequest(req, res))
        }
        // The body is read here to see it, so the transport is handed it parsed.
        const observe = observer
        return readJson(req).then(async (body) => {
          if (body === undefined) {
            res.writeHead(400).end()
            return
          }
          for (const message of Array.isArray(body) ? body : [body]) observe(message)
          await server.connect(transport)
          await transport.handleRequest(req, res, body)
        })
      })
      .catch((error: unknown) => {
        console.error('[gui] MCP request failed', error)
        if (!res.headersSent) res.writeHead(500).end()
      })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = http.address() as AddressInfo
  allowedHosts = [`127.0.0.1:${port}`]

  return {
    config: (websites = true) => ({
      type: 'http',
      name: MCP_SERVER_NAME,
      url: `http://127.0.0.1:${port}${websites ? PATHS.websites : PATHS.noWebsites}`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    }),
    // Calls still in flight hang up with it; their work checks the opening is still current
    // before it touches the preview (PreviewTools `live`).
    close: () => {
      http.close()
      http.closeAllConnections()
    },
  }
}
