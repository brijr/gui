import type { AgentId } from '../shared/types'
import { MCP_SERVER_NAME } from './mcp-server'

/** Readable labels for Gui's own tools, which agents report by raw MCP name. */
export const GUI_TOOL_LABELS: Record<string, string> = {
  preview_screenshot: 'Screenshot the preview',
  recording_info: 'Read recording timing',
  recording_frame: 'Inspect a recorded frame',
  recording_frames: 'Inspect recorded animation',
  recording_timeline: 'Read recording timeline',
  recording_narration: 'Read what you said',
  preview_inspect: 'Inspect element',
  preview_snapshot: 'Read preview page',
  preview_click: 'Click in preview',
  preview_hover: 'Hover in preview',
  preview_type: 'Type in preview',
  preview_press: 'Press key in preview',
  preview_scroll: 'Scroll preview',
  preview_point: 'Point out in preview',
  preview_console: 'Check preview errors',
  preview_navigate: 'Open page in preview',
  preview_reload: 'Reload preview',
  dev_server_logs: 'Read dev server logs',
  dev_server_status: 'Check dev server',
  dev_server_restart: 'Restart dev server',
  set_start_command: 'Change start command',
  source_control_status: 'Check source control',
  source_control_propose: 'Propose changes to ship',
  chat_turns: 'Read earlier turns',
}
const PREVIEW_TOOLS = Object.keys(GUI_TOOL_LABELS).join('|')
/**
 * Exact MCP identities for Gui's tools, anchored at both ends: shell command titles
 * are model-written text and must never be mistaken for a preview tool. Claude reports
 * `mcp__gui__<tool>` (never as `execute`); Codex reports every MCP call as an
 * `execute` titled `mcp.gui.<tool>`. Labels only: nothing is approved by title.
 */
const CLAUDE_TOOL = new RegExp(`^mcp__${MCP_SERVER_NAME}__(${PREVIEW_TOOLS})$`)
const CODEX_TOOL = new RegExp(`^mcp\\.${MCP_SERVER_NAME}\\.(${PREVIEW_TOOLS})$`)
const ANY_TOOL = new RegExp(
  `^(?:mcp__${MCP_SERVER_NAME}__|mcp\\.${MCP_SERVER_NAME}\\.|${MCP_SERVER_NAME}[_.])(${PREVIEW_TOOLS})$`,
)

export function previewTool(agentId: AgentId, title: string, kind: string | undefined) {
  if (agentId === 'codex') return title.match(CODEX_TOOL)?.[1]
  // Other agents name MCP calls their own way, but a shell command (`execute`) is never one.
  if (kind === 'execute') return undefined
  return title.match(agentId === 'claude' ? CLAUDE_TOOL : ANY_TOOL)?.[1]
}
