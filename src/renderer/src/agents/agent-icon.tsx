import { type AgentId, agentName } from '../../../shared/types'
import { cn } from '../lib/cn'
import { AGENT_LOGOS, AgentLogo } from './agent-logos'

/**
 * An agent's mark on a black 28px tile, the same in either appearance: its logo for the
 * built-in agents (agent-logos.tsx), or the first letter of its name for one the user added.
 */
export function AgentIcon({ agentId, className }: { agentId: AgentId; className?: string }) {
  const logo = Object.hasOwn(AGENT_LOGOS, agentId)
  return (
    <span
      aria-hidden="true"
      className={cn(
        // Black and white whatever the theme; the edge is a hairline that's stronger in the
        // dark, so the tile doesn't sink into a dark row.
        'flex size-7 shrink-0 items-center justify-center rounded-md bg-tile text-small font-medium text-tile-fg ring-1 ring-tile-edge ring-inset',
        className,
      )}
    >
      {logo ? (
        <AgentLogo agentId={agentId} className={agentId === 'amp' ? 'h-4 w-5' : 'size-4'} />
      ) : (
        agentName(agentId).trim().charAt(0).toUpperCase() || '?'
      )}
    </span>
  )
}
