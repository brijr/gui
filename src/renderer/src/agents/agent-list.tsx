import { Check } from 'lucide-react'
import type { AgentHealth, AgentId } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { GroupLabel, List } from '../lib/surface'
import { Button, PRESS } from '../lib/ui'
import { AgentStatusLabel } from '../settings/agent-status'
import { AgentNextStep } from './agent-card'
import { AgentIcon } from './agent-icon'

/**
 * Every agent the user has on, with its status: the one in use is marked, and choosing
 * another switches to it. The one in use shows its next step (install, sign in, try again)
 * under its row, unless it's ready.
 */
export function AgentList({ agents, agentId }: { agents: AgentHealth[]; agentId: AgentId }) {
  // Switched-off agents stay out, except the one in use, so the list shows what's running.
  const shown = agents.filter((agent) => agent.enabled || agent.id === agentId)
  return (
    <section aria-labelledby="agents-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <GroupLabel id="agents-heading" as="h2">
          Agents
        </GroupLabel>
        <Button variant="ghost" size="sm" onClick={() => gui.openSettings('agents')}>
          Settings
        </Button>
      </div>
      <List aria-labelledby="agents-heading">
        {shown.map((agent) => (
          <AgentListRow key={agent.id} health={agent} current={agent.id === agentId} />
        ))}
      </List>
    </section>
  )
}

function AgentListRow({ health, current }: { health: AgentHealth; current: boolean }) {
  return (
    <li className={cn(current && 'bg-accent-soft/40')}>
      <button
        type="button"
        // Named with its status ("Codex Ready"); the one in use says so.
        aria-current={current || undefined}
        onClick={() => {
          if (!current) gui.setAgent(health.id)
        }}
        className={cn(
          'flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-[background-color,opacity] focus-visible:-outline-offset-2',
          !current && `hover:bg-hover ${PRESS}`,
        )}
      >
        <AgentIcon agentId={health.id} />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-medium">{health.name}</span>
          <AgentStatusLabel health={health} />
        </span>
        {current && (
          <span className="flex shrink-0 items-center gap-1 text-small font-medium text-accent-text">
            <Check className="size-3.5" aria-hidden="true" />
            In use
          </span>
        )}
      </button>
      {current && health.status !== 'ready' && (
        <div className="px-3 pb-3 pl-13">
          <AgentNextStep name={health.name} health={health} />
        </div>
      )}
    </li>
  )
}
