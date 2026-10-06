import type { AgentHealth, AgentId } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Check } from '../lib/icons'
import { List, SectionHeader } from '../lib/surface'
import { PRESS, TextButton } from '../lib/ui'
import { AgentStatusLabel } from '../settings/agent-status'
import { AgentNextStep } from './agent-card'
import { AgentIcon } from './agent-icon'

/**
 * Every agent the user has on, with its status: the one in use is marked, and choosing
 * another switches to it. The one in use shows its next step (install, sign in, try again)
 * under its row, unless it's ready or still being checked.
 */
export function AgentList({ agents, agentId }: { agents: AgentHealth[]; agentId: AgentId }) {
  // Switched-off agents stay out, except the one in use, so the list shows what's running.
  const shown = agents.filter((agent) => agent.enabled || agent.id === agentId)
  return (
    <section aria-labelledby="agents-heading" className="flex flex-col gap-2">
      <SectionHeader
        id="agents-heading"
        action={
          <TextButton className="text-small font-medium" onClick={() => gui.openSettings('agents')}>
            Settings
          </TextButton>
        }
      >
        Agents
      </SectionHeader>
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
    // The one in use has the selected look (accent-soft, its marker in accent text); the
    // others are rows like ListRow's flush ones.
    <li className={cn(current && 'bg-accent-soft')}>
      <button
        type="button"
        // Named with its status ("Codex Ready"); the one in use says so.
        aria-current={current || undefined}
        // Choosing an agent that hasn't been checked yet checks it as it switches.
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
      {/* Not while checking: its row already says so, and a check that ends ready would
          add a line only to take it away. */}
      {current && health.status !== 'ready' && health.status !== 'checking' && (
        <div className="px-3 pb-3 pl-13">
          <AgentNextStep name={health.name} health={health} />
        </div>
      )}
    </li>
  )
}
