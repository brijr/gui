import { useId } from 'react'
import {
  type AgentHealth,
  type AgentId,
  agentName,
  type SettingsState,
} from '../../../shared/types'
import { grat } from '../lib/api'
import { List, Switch } from './controls'

interface Choice {
  id: AgentId
  label: string
}

function isSelectable(agent: AgentHealth) {
  return agent.enabled && agent.status !== 'not-installed'
}

function choiceLabel(agent: AgentHealth) {
  if (!agent.enabled) return `${agent.name} (disabled)`
  if (agent.status === 'not-installed') return `${agent.name} (not installed)`
  return agent.name
}

export function ChatSection({ settings }: { settings: SettingsState }) {
  const { agents, defaultAgentId, chatDocked } = settings
  const selectId = useId()
  const helpId = useId()

  // The saved default always stays in the list, even if it was switched off or removed,
  // so the select keeps showing what's actually saved.
  const shown = agents.filter((agent) => agent.id === defaultAgentId || isSelectable(agent))
  const choices: Choice[] = shown.map((agent) => ({ id: agent.id, label: choiceLabel(agent) }))
  if (!shown.some((agent) => agent.id === defaultAgentId)) {
    choices.push({ id: defaultAgentId, label: `${agentName(defaultAgentId)} (unavailable)` })
  }

  return (
    <List>
      <li className="flex items-center justify-between gap-4 px-3 py-2.5">
        <div className="min-w-0">
          <label htmlFor={selectId} className="block font-medium">
            Default agent
          </label>
          <p id={helpId} className="text-[12px] text-muted">
            New windows start with this agent.
          </p>
        </div>
        <select
          id={selectId}
          aria-describedby={helpId}
          value={defaultAgentId}
          onChange={(event) => grat.setDefaultAgent(event.target.value)}
          className="h-7 max-w-56 shrink-0 rounded-md border border-line-strong bg-raised px-2 text-[12px] text-fg outline-none focus:border-accent"
        >
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </li>
      <li className="px-3 py-1.5">
        <Switch
          checked={chatDocked}
          onCheckedChange={(docked) => grat.setChatDocked(docked)}
          label="Start the chat docked to the side"
          className="w-full justify-between text-fg"
        />
      </li>
    </List>
  )
}
