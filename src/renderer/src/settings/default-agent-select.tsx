import { type AgentHealth, type AgentId, agentName } from '../../../shared/types'
import { grat } from '../lib/api'

function isSelectable(agent: AgentHealth) {
  return agent.enabled && agent.status !== 'not-installed'
}

function choiceLabel(agent: AgentHealth) {
  if (!agent.enabled) return `${agent.name} (turned off)`
  if (agent.status === 'not-installed') return `${agent.name} (not installed)`
  return agent.name
}

/** Picks the agent new windows start with. */
export function DefaultAgentSelect({
  agents,
  defaultAgentId,
}: {
  agents: AgentHealth[]
  defaultAgentId: AgentId
}) {
  // The saved default always stays in the list, even if it was switched off or removed,
  // so the select keeps showing what's actually saved.
  const shown = agents.filter((agent) => agent.id === defaultAgentId || isSelectable(agent))
  const choices = shown.map((agent) => ({ id: agent.id, label: choiceLabel(agent) }))
  if (!shown.some((agent) => agent.id === defaultAgentId)) {
    choices.push({ id: defaultAgentId, label: `${agentName(defaultAgentId)} (unavailable)` })
  }
  return (
    <select
      aria-label="Default agent"
      title="New windows start with this agent"
      value={defaultAgentId}
      onChange={(event) => grat.setDefaultAgent(event.target.value)}
      className="no-drag h-7 max-w-48 shrink-0 rounded-md border border-line-strong bg-raised px-2 text-[12px] text-fg outline-none focus:border-accent"
    >
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.label}
        </option>
      ))}
    </select>
  )
}
