import type { AgentHealth } from '../../../shared/types'
import { cn } from '../lib/cn'
import { Check } from '../lib/icons'
import { Spinner } from '../lib/ui'

const LABEL = 'flex shrink-0 items-center gap-1 text-small font-medium'

/**
 * An agent's status in a word or two, beside its name, the same on the start screen and in
 * Settings: one weight whatever the state, and the color says which. An agent that hasn't
 * been checked yet was found on PATH, so it reads as installed; Settings puts a "Check now"
 * after it. An error's message is the tooltip here, and said in full where the agent is
 * shown on its own (its next step, its Settings row).
 */
export function AgentStatusLabel({ health }: { health: AgentHealth }) {
  switch (health.status) {
    case 'ready':
      return (
        <span className={cn(LABEL, 'text-success')}>
          <Check className="size-3" aria-hidden="true" />
          Ready
        </span>
      )
    case 'checking':
    case 'installing':
    case 'signing-in':
      return (
        <span className={cn(LABEL, 'gap-1.5 text-subtle')}>
          <Spinner />
          {health.status === 'checking'
            ? 'Checking'
            : health.status === 'installing'
              ? 'Installing'
              : 'Signing in'}
        </span>
      )
    case 'signed-out':
      return <span className={cn(LABEL, 'text-warning')}>Not signed in</span>
    case 'error':
      return (
        <span className={cn(LABEL, 'text-danger')} title={health.message ?? undefined}>
          Unavailable
        </span>
      )
    case 'not-installed':
      return <span className={cn(LABEL, 'text-subtle')}>Not installed</span>
    case 'unknown':
      return <span className={cn(LABEL, 'text-subtle')}>Installed</span>
    default:
      return null
  }
}
