import { Check, TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type AgentHealth, type AgentId, agentName } from '../../../shared/types'
import { grat } from '../lib/api'
import { Button, Spinner, TechnicalDetails } from '../lib/ui'

interface AgentCardProps {
  agentId: AgentId
  /** The agent's status; null when Grat doesn't know it (e.g. removed from agents.json) */
  health: AgentHealth | null
  /** The control for picking another agent (a menu on the start screen, a select in Settings) */
  change: ReactNode
}

/**
 * The agent the user works with, what state it's in, and the one thing to do next:
 * install it, sign in, try again, or nothing because it's ready.
 */
export function AgentCard({ agentId, health, change }: AgentCardProps) {
  const name = health?.name ?? agentName(agentId)
  return (
    <section
      aria-label="Your agent"
      className="flex flex-col gap-2 rounded-lg border border-line bg-raised px-3 py-2.5"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-subtle">Your agent</p>
          <p className="truncate font-medium text-[13px]">{name}</p>
        </div>
        {change}
      </div>
      <AgentNextStep name={name} health={health} />
    </section>
  )
}

function AgentNextStep({ name, health }: { name: string; health: AgentHealth | null }) {
  const [error, setError] = useState<string | null>(null)

  const signIn = async (agent: AgentHealth) => {
    setError(null)
    try {
      await grat.signIn(agent.id)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(err),
      )
    }
  }

  if (!health) {
    return (
      <Step tone="danger" text={`Grat can't find ${name}. Pick another agent or add it back.`}>
        <Button onClick={() => grat.openSettings('agents')}>Agent settings</Button>
      </Step>
    )
  }

  if (!health.enabled) {
    return (
      <Step text={`${name} is turned off.`}>
        <Button onClick={() => grat.setAgentEnabled(health.id, true)}>Turn on</Button>
      </Step>
    )
  }

  switch (health.status) {
    case 'ready':
      return (
        <p className="flex items-center gap-1.5 text-[12px] text-success">
          <Check className="size-3.5" aria-hidden="true" />
          Ready
        </p>
      )
    case 'checking':
      return <Waiting text={`Checking ${name}…`} />
    case 'signing-in':
      return <Waiting text={health.message ?? 'Waiting for you to sign in…'} />
    case 'not-installed':
      return (
        <Step
          text={`${name} isn't installed yet. Install it, then come back. Grat picks it up on its own.`}
          note={health.command ? `Needs the ${health.command} command on your PATH.` : undefined}
        >
          {health.installUrl && (
            <Button variant="primary" onClick={() => grat.installAgent(health.id)}>
              Install {name}
            </Button>
          )}
          <Button variant="ghost" onClick={() => grat.checkAgents()}>
            Check again
          </Button>
        </Step>
      )
    case 'signed-out':
      return (
        <Step
          tone="warning"
          text={`Sign in to ${name} to start.`}
          note={health.message ?? undefined}
        >
          {health.signIn && (
            <Button variant="primary" onClick={() => void signIn(health)}>
              {health.signIn.label}
            </Button>
          )}
          <Button variant="ghost" onClick={() => grat.checkAgents()}>
            Check again
          </Button>
          {error && <p className="w-full text-[12px] text-danger">{error}</p>}
        </Step>
      )
    case 'error':
      return (
        <Step tone="danger" text={health.message ?? `${name} isn't working right now.`}>
          <Button onClick={() => grat.checkAgents()}>Try again</Button>
          {health.detail && <TechnicalDetails text={health.detail} className="w-full" />}
        </Step>
      )
    default:
      return (
        <Step text={`${name} hasn't been checked yet.`}>
          <Button onClick={() => grat.checkAgents()}>Check</Button>
        </Step>
      )
  }
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-[12px] text-muted">
      <Spinner className="size-2.5" />
      {text}
    </p>
  )
}

interface StepProps {
  text: string
  /** Secondary detail for people who want the specifics (commands, paths) */
  note?: string
  tone?: 'warning' | 'danger'
  children: ReactNode
}

function Step({ text, note, tone, children }: StepProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <p className="flex gap-1.5 text-pretty text-[12px]">
          {tone && (
            <TriangleAlert
              className={
                tone === 'danger'
                  ? 'mt-0.5 size-3.5 shrink-0 text-danger'
                  : 'mt-0.5 size-3.5 shrink-0 text-warning'
              }
              aria-hidden="true"
            />
          )}
          <span>{text}</span>
        </p>
        {note && <p className="select-text text-pretty text-[11.5px] text-subtle">{note}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  )
}
