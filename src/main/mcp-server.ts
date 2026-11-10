import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { APP_TOOL_NAMES, type AppTools, registerAppTools } from './mcp-app-tools'
import { BOARD_TOOL_NAMES, type BoardTools, registerBoardTools } from './mcp-board-tools'
import { PREVIEW_TOOL_NAMES, registerPreviewTools } from './mcp-preview-tools'
import type { PreviewTools } from './preview-tools'
import type { Recordings } from './recordings'

export const MCP_SERVER_NAME = 'gui'

/**
 * Every tool Gui exposes: the preview's (mcp-preview-tools.ts), Gui's own (mcp-app-tools.ts)
 * and, in a canvas, the canvas's (mcp-board-tools.ts).
 */
export const GUI_TOOL_NAMES = [
  ...PREVIEW_TOOL_NAMES,
  ...APP_TOOL_NAMES,
  ...BOARD_TOOL_NAMES,
] as const

interface Sdk {
  McpServer: typeof McpServer
  StreamableHTTPServerTransport: typeof StreamableHTTPServerTransport
}

let sdk: Promise<Sdk> | null = null

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
) {
  const server = new McpServer({ name: 'gui', version: '0.2.0' })
  registerPreviewTools(server, tools, recordings, board === null)
  registerAppTools(server, app)
  if (board) registerBoardTools(server, board)
  return server
}

export interface RunningMcpServer {
  /** Ready to pass in ACP `session/new` / `session/load` */
  config: AcpMcpServer
  close(): void
}

/**
 * Serves Gui's tools over MCP Streamable HTTP on loopback, stateless, behind a
 * per-window bearer token so only the agent sessions Gui starts can call them.
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
    if (req.url !== '/mcp' || !authorized(req.headers.authorization)) {
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
        const server = buildServer(loaded, tools, recordings, app, board)
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
        return server.connect(transport).then(() => transport.handleRequest(req, res))
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
    config: {
      type: 'http',
      name: MCP_SERVER_NAME,
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
    close: () => http.close(),
  }
}
