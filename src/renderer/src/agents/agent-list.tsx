import { useState } from 'react'
import type { AgentHealth, AgentId } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Check, ChevronRight } from '../lib/icons'
import { List, ListRow, SectionHeader } from '../lib/surface'
import { TextButton } from '../lib/ui'
import { AgentOffLabel, AgentStatusLabel } from '../settings/agent-status'
import { AgentNextStep, binaryLabel } from './agent-card'
import { AgentIcon } from './agent-icon'

/**
 * Every agent the user has on, with its status: the one in use is marked, and choosing
 * another switches to it. The one in use shows its next step (install, sign in, try again)
 * under its row; once it's ready, only which CLI Gui runs. Agents that aren't installed
 * fold into one row, so the few that can work aren't lost among the many that can't.
 */
export function AgentList({ agents, agentId }: { agents: AgentHealth[]; agentId: AgentId }) {
  const [showMissing, setShowMissing] = useState(false)
  // Switched-off agents stay out, except the one in use, so the list shows what's running.
  const shown = agents.filter((agent) => agent.enabled || agent.id === agentId)
  const missing = shown.filter((agent) => agent.status === 'not-installed' && agent.id !== agentId)
  const listed = showMissing ? shown : shown.filter((agent) => !missing.includes(agent))
  return (
    <section aria-labelledby="agents-heading" className="flex flex-col gap-2">
      <SectionHeader
        id="agents-heading"
        action={<TextButton onClick={() => gui.openSettings('agents')}>Settings</TextButton>}
      >
        Agents
      </SectionHeader>
      <List aria-labelledby="agents-heading">
        {listed.map((agent) => (
          <AgentListRow key={agent.id} health={agent} current={agent.id === agentId} />
        ))}
        {missing.length > 0 && (
          <li>
            <ListRow
              flush
              aria-expanded={showMissing}
              onClick={() => setShowMissing((open) => !open)}
              className="text-small text-muted"
              heading={
                showMissing
                  ? 'Hide agents that aren’t installed'
                  : `${missing.length} more ${missing.length === 1 ? 'agent' : 'agents'}, not installed`
              }
              trailing={
                <ChevronRight
                  className={cn(
                    'size-3 shrink-0 text-subtle transition-transform motion-reduce:transition-none',
                    showMissing && 'rotate-90',
                  )}
                  aria-hidden="true"
                />
              }
            />
          </li>
        )}
      </List>
    </section>
  )
}

function AgentListRow({ health, current }: { health: AgentHealth; current: boolean }) {
  // Ready says so beside the name, so the one in use needs no next step, only its CLI.
  const ready = health.enabled && health.status === 'ready'
  return (
    // The one in use has the selected look, its next step under it too.
    <li className={cn(current && 'bg-accent-soft')}>
      <ListRow
        flush
        selected={current}
        // Named with its status ("Codex Ready"); the one in use says so.
        aria-current={current || undefined}
        // Choosing an agent that hasn't been checked yet checks it as it switches.
        onClick={() => {
          if (!current) gui.setAgent(health.id)
        }}
        leading={<AgentIcon agentId={health.id} />}
        detail={current && ready && health.binary ? binaryLabel(health.binary) : undefined}
        heading={
          <>
            <span className="truncate" title={health.name}>
              {health.name}
            </span>
            {health.enabled ? <AgentStatusLabel health={health} /> : <AgentOffLabel />}
          </>
        }
        trailing={
          current && (
            <span className="flex shrink-0 items-center gap-1 text-small font-medium text-accent-text">
              <Check className="size-3.5" aria-hidden="true" />
              In use
            </span>
          )
        }
      />
      {/* Keep the next step mounted as checks and installation change its controls. */}
      {current && !ready && (
        <div className="px-3 pb-3 pl-13">
          <AgentNextStep name={health.name} health={health} />
        </div>
      )}
    </li>
  )
}
