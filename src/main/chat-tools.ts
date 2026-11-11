import type { AgentId } from '../shared/types'
import {
  ASK_FIRST_TOOLS,
  GUI_TOOL_NAMES,
  GUI_TOOL_TITLES,
  type GuiTool,
  MCP_SERVER_NAME,
} from './mcp-server'

/**
 * Readable labels for Gui's own tools, which agents report by raw MCP name: each tool's
 * title, so a new tool has one too. A turn keeps the label it was shown with, so chats saved
 * before a tool was renamed or merged still read the same.
 */
export const GUI_TOOL_LABELS: Record<GuiTool, string> = GUI_TOOL_TITLES

const PREVIEW_TOOLS = GUI_TOOL_NAMES.join('|')
/**
 * Exact MCP identities for Gui's tools, anchored at both ends: shell command titles
 * are model-written text and must never be mistaken for a preview tool. Claude reports
 * `mcp__gui__<tool>` (never as `execute`); Codex reports every MCP call as an
 * `execute` titled `mcp.gui.<tool>`. A title only labels a call, or keeps Gui from answering
 * for the user (`asksFirst`): nothing is ever approved by its title.
 */
const CLAUDE_TOOL = new RegExp(`^mcp__${MCP_SERVER_NAME}__(${PREVIEW_TOOLS})$`)
const CODEX_TOOL = new RegExp(`^mcp\\.${MCP_SERVER_NAME}\\.(${PREVIEW_TOOLS})$`)
const ANY_TOOL = new RegExp(
  `^(?:mcp__${MCP_SERVER_NAME}__|mcp\\.${MCP_SERVER_NAME}\\.|${MCP_SERVER_NAME}[_.])(${PREVIEW_TOOLS})$`,
)

export function previewTool(
  agentId: AgentId,
  title: string,
  kind: string | undefined | null,
): GuiTool | undefined {
  if (agentId === 'codex') return title.match(CODEX_TOOL)?.[1] as GuiTool | undefined
  // Other agents name MCP calls their own way, but a shell command (`execute`) is never one.
  if (kind === 'execute') return undefined
  return title.match(agentId === 'claude' ? CLAUDE_TOOL : ANY_TOOL)?.[1] as GuiTool | undefined
}

/**
 * Whether a permission request is for one of Gui's tools that the user decides every time
 * (ASK_FIRST_TOOLS): by the request's own title, or, when it has none (codex-acp), by the
 * label of the tool call it's about. Gui never answers those by itself.
 */
export function asksFirst(
  agentId: AgentId,
  request: { title?: string | null; kind?: string | null },
  call: { title: string; toolKind: string } | undefined,
) {
  const named = request.title ? previewTool(agentId, request.title, request.kind) : undefined
  if (named) return ASK_FIRST_TOOLS.has(named)
  if (call?.toolKind !== 'preview') return false
  return [...ASK_FIRST_TOOLS].some((tool) => GUI_TOOL_LABELS[tool as GuiTool] === call.title)
}
