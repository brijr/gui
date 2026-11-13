import type { OutsideClient } from './types'

/** The agents Settings shows how to connect, in its order. */
export const OUTSIDE_CLIENTS: readonly OutsideClient[] = ['claude', 'codex', 'cursor']

/** The name other agents know Gui's tools by, as Gui's own agents do (mcp-server.ts). */
const NAME = 'gui'

/**
 * What the user pastes to connect `client` to Gui (main/outside-mcp.ts). Settings shows it
 * with the token masked; main copies it with the real one.
 */
export function outsideSetup(client: OutsideClient, port: number, token: string) {
  const url = `http://127.0.0.1:${port}/mcp`
  switch (client) {
    case 'claude':
      return `claude mcp add --transport http ${NAME} ${url} --header "Authorization: Bearer ${token}"`
    case 'codex':
      return `[mcp_servers.${NAME}]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`
    case 'cursor':
      return JSON.stringify(
        { mcpServers: { [NAME]: { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      )
  }
}
