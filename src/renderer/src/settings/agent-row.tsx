import { type ReactNode, useState } from 'react'
import type { AgentHealth, AgentId } from '../../../shared/types'
import { gui } from '../lib/api'
import { TechnicalDetails } from '../lib/disclosure'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { ListItem } from '../lib/surface'
import { Button, Switch, TextButton } from '../lib/ui'
import { AgentOffLabel, AgentStatusLabel } from './agent-status'
import { useAction } from './use-action'

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
  const [signInError, setSignInError] = useState<string | null>(null)
  const retry = useAction()
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

  // A failed Claude Code or Codex download downloads again; anything else checks again.
  const tryAgain = (agent: AgentHealth) =>
    void retry.run(async () => {
      if (agent.install) await gui.installAgent(agent.id)
      else gui.checkAgents(agent.id)
    })

  const toggle = (next: boolean) => {
    if (health) gui.setAgentEnabled(health.id, next)
  }

  return (
    <ListItem
      align="start"
      quiet={!enabled}
      heading={
        <>
          <label htmlFor={`agent-switch-${health?.id ?? name}`} className="truncate" title={name}>
            {name}
          </label>
          {live ? <AgentStatusLabel health={live} /> : health && <AgentOffLabel />}
          {live?.status === 'unknown' && (
            <TextButton tone="muted" className="shrink-0" onClick={() => gui.checkAgents(live.id)}>
              Check now
            </TextButton>
          )}
        </>
      }
      trailing={
        <>
          {live?.signIn && live.status !== 'ready' && (
            <Button
              disabled={busy}
              loading={live.status === 'signing-in'}
              onClick={() => void signIn(live.id)}
            >
              {live.signIn.label}
            </Button>
          )}
          {live?.status === 'error' && (
            <Button loading={retry.pending} onClick={() => tryAgain(live)}>
              Try again
            </Button>
          )}
          {actions}
          {/* The switch's name is the agent's; its track says whether it's on. */}
          <Switch
            id={`agent-switch-${health?.id ?? name}`}
            checked={enabled}
            onCheckedChange={toggle}
            label={name}
            disabled={!health}
          />
        </>
      }
    >
      {detail}
      {/* An error says what went wrong in the danger color; other states explain themselves quietly. */}
      {live?.status === 'error' ? (
        <InlineError>{live.message ?? `${name} isn’t working right now.`}</InlineError>
      ) : (
        live &&
        live.status !== 'ready' &&
        live.message && (
          <p className="select-text text-pretty text-small text-muted">{live.message}</p>
        )
      )}
      {live?.status === 'error' && live.detail && <TechnicalDetails text={live.detail} />}
      {signInError && <InlineError>{signInError}</InlineError>}
      {retry.error && <InlineError>{retry.error}</InlineError>}
      {error && <InlineError>{error}</InlineError>}
    </ListItem>
  )
}
