import type { AgentHealth, AgentId } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { List, ListItem, SectionHeader } from '../lib/surface'
import { TextButton } from '../lib/ui'
import { AgentOffLabel, AgentStatusLabel } from '../settings/agent-status'
import { AgentNextStep, binaryLabel } from './agent-card'
import { AgentIcon } from './agent-icon'

/**
 * The agent in use, with its status and its one next step (install, sign in, try again) under
 * it, except while it's ready or being checked, which its status already says. Change opens
 * Settings → Agents, where the rest are.
 */
export function AgentList({ agents, agentId }: { agents: AgentHealth[]; agentId: AgentId }) {
  const health = agents.find((agent) => agent.id === agentId)
  if (!health) return null
  const ready = health.enabled && health.status === 'ready'
  const quiet = ready || (health.enabled && health.status === 'checking')
  return (
    <section aria-labelledby="agents-heading" className="flex flex-col gap-2">
      <SectionHeader
        id="agents-heading"
        action={<TextButton onClick={() => gui.openSettings('agents')}>Change</TextButton>}
      >
        Agent
      </SectionHeader>
      <List aria-labelledby="agents-heading">
        <ListItem
          align="start"
          heading={
            <>
              <AgentIcon agentId={health.id} />
              <span className="truncate" title={health.name}>
                {health.name}
              </span>
              {health.enabled ? <AgentStatusLabel health={health} /> : <AgentOffLabel />}
            </>
          }
          detail={ready && health.binary ? binaryLabel(health.binary) : undefined}
        >
          {/* Kept mounted while hidden, so focus moves to its next control once a check ends. */}
          <div className={cn('pt-2', quiet && 'hidden')}>
            <AgentNextStep name={health.name} health={health} />
          </div>
        </ListItem>
      </List>
    </section>
  )
}
