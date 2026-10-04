import type { AgentHealth } from '../../../shared/types'
import { Spinner } from '../lib/ui'

/** Same wording as the start screen's agent list. */
export function AgentStatusLabel({ health }: { health: AgentHealth }) {
  switch (health.status) {
    case 'ready':
      return <span className="text-[11.5px] text-success">Ready</span>
    case 'checking':
    case 'signing-in':
      return (
        <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
          <Spinner className="size-2.5" />
          {health.status === 'checking' ? 'Checking' : 'Signing in'}
        </span>
      )
    case 'signed-out':
      return <span className="text-[11.5px] text-warning">Not signed in</span>
    case 'error':
      return <span className="text-[11.5px] text-danger">Unavailable</span>
    case 'not-installed':
      return <span className="text-[11.5px] text-subtle">Not installed</span>
    default:
      return null
  }
}
