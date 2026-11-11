import type { AgentDefinition, PermissionPolicy } from './agents'
import { ASK_FIRST_TOOLS, GUI_TOOL_NAMES, MCP_SERVER_NAME } from './mcp-server'

/**
 * `_meta` for session/new and session/load. Claude asks before calling MCP tools; Gui's
 * own tools work inside the preview or wait for the user (a new start command, a proposed
 * commit), so allow them up front by exact name, all but ASK_FIRST_TOOLS, which an `ask`
 * rule keeps asking about in Claude's own Auto mode too (a page's address can carry data
 * out). Other agents ask Gui as they do for any tool, and Gui leaves those to the user
 * (chat.ts `autoAnswer`); Codex reviews MCP calls itself. Agents that take Ask or Auto only
 * as a session starts (Grok) get it here.
 */
export function sessionMeta(agent: AgentDefinition, policy: PermissionPolicy | undefined) {
  const permissions = policy ? agent.permissions?.sessionMeta?.[policy] : undefined
  if (agent.id !== 'claude') return permissions
  const named = (tool: string) => `mcp__${MCP_SERVER_NAME}__${tool}`
  const allowedTools = GUI_TOOL_NAMES.filter((tool) => !ASK_FIRST_TOOLS.has(tool)).map(named)
  const ask = [...ASK_FIRST_TOOLS].map(named)
  return {
    ...permissions,
    claudeCode: { options: { allowedTools, settings: { permissions: { ask } } } },
  }
}
