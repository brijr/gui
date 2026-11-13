import { app } from 'electron'
import { setFrameLimitForDevelopment } from '../shared/board'
import { observeMcpRequests } from './mcp-server'

/** One message an agent sent Gui's MCP server: its JSON-RPC method, and the tool it called. */
export interface McpTraceEntry {
  method: string
  tool: string | null
  at: number
}

/** The trace keeps the first this many messages; a smoke turn sends a handful. */
const MCP_TRACE_LIMIT = 1000

/**
 * Switches for trying Gui at sizes users can't reach yet. Unpackaged builds only: a packaged
 * Gui ignores them.
 *
 *   GUI_DEV_MAX_FRAMES=1000  a canvas may hold that many frames (users get MAX_FRAMES)
 *   GUI_E2E_MCP_TRACE=1      what agents ask Gui's MCP server goes in globalThis.guiMcpTrace
 *                            (McpTraceEntry[]), for the agent smoke test (smoke/)
 */
export function applyDevFlags() {
  if (app.isPackaged) return
  const frames = Number(process.env.GUI_DEV_MAX_FRAMES)
  if (frames) setFrameLimitForDevelopment(frames)
  if (process.env.GUI_E2E_MCP_TRACE === '1') traceMcpRequests()
}

function traceMcpRequests() {
  const trace: McpTraceEntry[] = []
  ;(globalThis as { guiMcpTrace?: McpTraceEntry[] }).guiMcpTrace = trace
  observeMcpRequests((message) => {
    if (trace.length >= MCP_TRACE_LIMIT || typeof message !== 'object' || message === null) return
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } }
    if (typeof method !== 'string') return
    const tool = method === 'tools/call' && typeof params?.name === 'string' ? params.name : null
    trace.push({ method, tool, at: Date.now() })
  })
}
