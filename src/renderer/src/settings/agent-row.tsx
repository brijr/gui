import { type ReactNode, useId, useState } from 'react'
import type { AgentHealth, AgentId } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { Button } from '../lib/ui'
import { AgentStatusLabel } from './agent-status'
import { Switch } from './controls'
import { errorMessage } from './use-action'

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
      await grat.signIn(agentId)
    } catch (err) {
      setSignInError(errorMessage(err))
    }
  }

  const toggle = (next: boolean) => {
    if (health) grat.setAgentEnabled(health.id, next)
  }

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={cn('flex items-center gap-2', !enabled && 'text-muted')}>
          <span id={nameId} className="font-medium">
            {name}
          </span>
          {live && <AgentStatusLabel health={live} />}
        </p>
        {detail}
        {live && live.status !== 'ready' && (live.message || signInError) && (
          <p className="mt-0.5 select-text text-pretty text-[12px] text-muted">
            {signInError ?? live.message}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-0.5 select-text text-pretty text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="-my-1 flex shrink-0 items-center gap-2">
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
          disabled={!health}
          className="text-[11.5px] text-muted hover:text-fg"
        />
      </div>
    </li>
  )
}
