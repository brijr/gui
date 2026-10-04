import { Check } from 'lucide-react'
import type { AgentHealth } from '../../../shared/types'
import { Spinner } from '../lib/ui'

/** Same wording and look as the start screen's agent card. */
export function AgentStatusLabel({ health }: { health: AgentHealth }) {
  switch (health.status) {
    case 'ready':
      return (
        <span className="flex items-center gap-1 text-small font-medium text-success">
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
      return <span className="text-small font-medium text-warning">Not signed in</span>
    case 'error':
      return <span className="text-small font-medium text-danger">Unavailable</span>
    case 'not-installed':
      return <span className="text-small font-normal text-subtle">Not installed</span>
    default:
      return null
  }
}
