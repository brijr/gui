import type { AgentHealth } from '../../../shared/types'
import { gui } from '../lib/api'
import { Check } from '../lib/icons'
import { Spinner } from '../lib/ui'

/**
 * Same wording as the start screen's agent card. Beside the agent's name, in the regular weight
 * whatever the state; the color says which.
 */
export function AgentStatusLabel({
  health,
  checkable = true,
}: {
  health: AgentHealth
  /** False inside a control that runs the check itself, so "Check now" is only its label */
  checkable?: boolean
}) {
  switch (health.status) {
    case 'ready':
      return (
        <span className="flex items-center gap-1 text-small font-normal text-success">
          <Check className="size-3" aria-hidden="true" />
          Ready
        </span>
      )
    case 'checking':
    case 'installing':
    case 'signing-in':
      return (
        <span className="flex items-center gap-1.5 text-small font-normal text-subtle">
          <Spinner />
          {health.status === 'checking'
            ? 'Checking'
            : health.status === 'installing'
              ? 'Installing'
              : 'Signing in'}
        </span>
      )
    case 'signed-out':
      return <span className="text-small font-normal text-warning">Not signed in</span>
    case 'error':
      return <span className="text-small font-normal text-danger">Unavailable</span>
    case 'not-installed':
      return <span className="text-small font-normal text-subtle">Not installed</span>
    case 'unknown':
      return checkable ? (
        <button
          type="button"
          onClick={() => gui.checkAgents(health.id)}
          className="text-small font-normal text-accent-text"
        >
          Check now
        </button>
      ) : (
        <span className="text-small font-normal text-accent-text">Check now</span>
      )
    default:
      return null
  }
}
