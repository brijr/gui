import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { APP_TOOL_NAMES, type AppTools, registerAppTools } from './mcp-app-tools'
import { PREVIEW_TOOL_NAMES, registerPreviewTools } from './mcp-preview-tools'
import type { PreviewTools } from './preview-tools'
import type { Recordings } from './recordings'

export const MCP_SERVER_NAME = 'gui'

/** Every tool Gui exposes: the preview's (mcp-preview-tools.ts) and Gui's own (mcp-app-tools.ts). */
export const GUI_TOOL_NAMES = [...PREVIEW_TOOL_NAMES, ...APP_TOOL_NAMES] as const

function buildServer(tools: PreviewTools, recordings: Recordings, app: AppTools) {
  const server = new McpServer({ name: 'gui', version: '0.2.0' })
  registerPreviewTools(server, tools, recordings)
  registerAppTools(server, app)
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
    const server = buildServer(tools, recordings, app)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      allowedHosts,
      enableDnsRebindingProtection: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
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
