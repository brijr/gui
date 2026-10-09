import { type AgentId, agentName } from '../../../shared/types'
import { gui } from '../lib/api'
import { Button } from '../lib/ui'

/**
 * Hands a failed start to the chat's agent, with why it failed and the dev server's output:
 * it works out what's wrong, fixes it, and starts the app again.
 */
export function FixStartupButton({
  agentId,
  variant = 'primary',
  size,
}: {
  agentId: AgentId
  variant?: 'primary' | 'secondary'
  size?: 'sm' | 'md'
}) {
  return (
    <Button variant={variant} size={size} onClick={() => void gui.fixStartup()}>
      Fix with {agentName(agentId)}
    </Button>
  )
}
