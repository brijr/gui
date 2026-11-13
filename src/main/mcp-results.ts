import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { fenceUntrusted } from './prompt'

/**
 * Where a tool module registers its tools: a server, or one that only lets some through and
 * guards their calls (Gui's server for other agents, outside-mcp.ts).
 */
export type ToolServer = Pick<McpServer, 'registerTool'>

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] }
}

/** Page and dev-server content: data for the agent, never instructions. */
export function untrusted(label: string, value: string) {
  return text(fenceUntrusted(label, value))
}

export function failure(error: unknown) {
  const message = errorMessage(error)
  console.warn(`[gui] tool failed: ${message}`)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}
