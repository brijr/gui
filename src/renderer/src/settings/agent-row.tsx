import { type ReactNode, useId, useState } from 'react'
import type { AgentHealth, AgentId } from '../../../shared/types'
import { gui } from '../lib/api'
import { TechnicalDetails } from '../lib/disclosure'
import { readableError } from '../lib/errors'
import { ListItem } from '../lib/surface'
import { Button, Switch } from '../lib/ui'
import { AgentStatusLabel } from './agent-status'

interface AgentRowProps {
  name: string
  /** Null until main reports this agent */
  health: AgentHealth | null
  /** Extra lines under the name */
  detail?: ReactNode
  /** Buttons shown before the switch */
  actions?: ReactNode
  /** A failed action on this row, shown in the danger color */
  error?: string | null
}

/** One agent in a settings list: name, status, sign-in, and the on/off switch. */
export function AgentRow({ name, health, detail, actions, error }: AgentRowProps) {
  const nameId = useId()
  const [signInError, setSignInError] = useState<string | null>(null)
  // A disabled agent isn't checked, so whatever status it last had would mislead.
  const live = health?.enabled ? health : null
  const enabled = live !== null
  const busy = live?.status === 'checking' || live?.status === 'signing-in'

  const signIn = async (agentId: AgentId) => {
    setSignInError(null)
    try {
      await gui.signIn(agentId)
    } catch (err) {
      setSignInError(readableError(err))
    }
  }

  const toggle = (next: boolean) => {
    if (health) gui.setAgentEnabled(health.id, next)
  }

  return (
    <ListItem
      align="start"
      quiet={!enabled}
      title={
        <>
          <span id={nameId}>{name}</span>
          {live && <AgentStatusLabel health={live} />}
        </>
      }
      trailing={
        <>
          {live?.signIn && live.status !== 'ready' && (
            <Button disabled={busy} onClick={() => void signIn(live.id)}>
              {live.status === 'signing-in' ? 'Waiting…' : live.signIn.label}
            </Button>
          )}
          {actions}
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            label="Enabled"
            labelledBy={nameId}
            // A row of agents each saying "Enabled" reads as noise; the track says it.
            labelHidden
            disabled={!health}
            className="text-small text-muted hover:text-fg"
          />
        </>
      }
    >
      {detail}
      {live && live.status !== 'ready' && (live.message || signInError) && (
        <p className="select-text text-pretty text-small text-muted">
          {signInError ?? live.message}
        </p>
      )}
      {live?.status === 'error' && live.detail && <TechnicalDetails text={live.detail} />}
      {error && (
        <p role="alert" className="select-text text-pretty text-small text-danger">
          {error}
        </p>
      )}
    </ListItem>
  )
}
