import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { PreviewTools } from './preview-tools'

export const MCP_SERVER_NAME = 'grat'

/** Tool names Grat exposes; all are read-only views of the preview except navigation. */
export const PREVIEW_TOOL_NAMES = [
  'preview_screenshot',
  'preview_inspect',
  'preview_console',
  'preview_navigate',
  'preview_reload',
  'dev_server_logs',
] as const

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] }
}

function failure(error: unknown) {
  const message = errorMessage(error)
  console.warn(`[grat] preview tool failed: ${message}`)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

function buildServer(tools: PreviewTools) {
  const server = new McpServer({ name: 'grat-preview', version: '0.1.0' })

  server.registerTool(
    'preview_screenshot',
    {
      title: 'Screenshot the preview',
      description:
        "Screenshot the user's running app in Grat's preview. Use after making visual changes to check the result. Pass `selector` to capture one element, `width` (CSS px) to check a responsive breakpoint such as 390 or 768 (the viewport is restored afterwards), or `fullPage` for the whole scrollable page.",
      inputSchema: {
        selector: z.string().max(500).optional().describe('CSS selector of an element to capture'),
        width: z.number().int().min(240).max(3840).optional().describe('Viewport width in CSS px'),
        fullPage: z.boolean().optional().describe('Capture the full scrollable page'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ selector, width, fullPage }) => {
      try {
        const shot = await tools.screenshot({ selector, width, fullPage })
        const what = selector ? `\`${selector}\`` : fullPage ? 'full page' : 'viewport'
        return {
          content: [
            { type: 'image' as const, data: shot.data, mimeType: shot.mimeType },
            {
              type: 'text' as const,
              text: `${what} at viewport width ${shot.viewportWidth}px (${shot.width}×${shot.height} image)`,
            },
          ],
        }
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'preview_inspect',
    {
      title: 'Inspect an element',
      description:
        'Computed styles, size and position, text, attributes, React component stack, and source file:line for the first element matching a CSS selector in the live preview. Use to measure spacing, check fonts and colors, or find which file renders something.',
      inputSchema: { selector: z.string().min(1).max(500).describe('CSS selector') },
      annotations: { readOnlyHint: true },
    },
    async ({ selector }) => {
      try {
        const element = await tools.inspect(selector)
        return text(JSON.stringify(element, null, 2))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'preview_console',
    {
      title: 'Read preview errors',
      description:
        "Recent console errors and warnings from the preview since its last navigation, plus dev-server build errors. Check this after edits if something looks wrong or the page didn't update.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { url, messages, problems } = tools.console()
      const lines = [`Page: ${url ?? '(none)'}`]
      lines.push(problems.length ? `Current errors (${problems.length}):` : 'No current errors.')
      for (const problem of problems) lines.push(`- [${problem.source}] ${problem.message}`)
      const warnings = messages.filter((m) => m.level === 'warning')
      if (warnings.length) {
        lines.push(`Recent warnings (${warnings.length}):`)
        for (const warning of warnings.slice(-15)) lines.push(`- ${warning.message}`)
      }
      return text(lines.join('\n'))
    },
  )

  server.registerTool(
    'preview_navigate',
    {
      title: 'Open a page in the preview',
      description: 'Navigate the preview to a path on the dev server, e.g. `/pricing`.',
      inputSchema: { path: z.string().min(1).max(2000).describe('Path or URL on the dev server') },
    },
    async ({ path }) => {
      try {
        return text(`Opened ${await tools.navigate(path)}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'preview_reload',
    {
      title: 'Reload the preview',
      description: 'Reload the preview page, e.g. after changes hot reload could not apply.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(`Reloaded ${await tools.reload()}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'dev_server_logs',
    {
      title: 'Read dev server output',
      description:
        "The tail of the project's dev server output (already running in Grat; never start another one).",
      inputSchema: {
        lines: z.number().int().min(1).max(500).optional().describe('How many lines (default 80)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ lines }) => text(tools.logs(lines ?? 80) || '(no output yet)'),
  )

  return server
}

export interface RunningMcpServer {
  /** Ready to pass in ACP `session/new` / `session/load` */
  config: AcpMcpServer
  close(): void
}

/**
 * Serves the preview tools over MCP Streamable HTTP on loopback, stateless, behind a
 * per-window bearer token so only the agent sessions Grat starts can call them.
 */
export async function startMcpServer(tools: PreviewTools): Promise<RunningMcpServer> {
  const token = randomBytes(24).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const authorized = (header: string | undefined) => {
    const given = Buffer.from(header ?? '')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

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
    const server = buildServer(tools)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((error: unknown) => {
        console.error('[grat] MCP request failed', error)
        if (!res.headersSent) res.writeHead(500).end()
      })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = http.address() as AddressInfo

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
