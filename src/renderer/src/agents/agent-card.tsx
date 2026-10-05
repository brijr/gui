import { type ReactNode, useState } from 'react'
import {
  type AgentBinarySource,
  type AgentHealth,
  type AgentId,
  agentName,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { TechnicalDetails } from '../lib/disclosure'
import { readableError } from '../lib/errors'
import { Check, TriangleAlert } from '../lib/icons'
import { Card, GroupLabel } from '../lib/surface'
import { Button, Spinner } from '../lib/ui'

interface AgentCardProps {
  agentId: AgentId
  /** The agent's status; null when Gui doesn't know it (e.g. removed from agents.json) */
  health: AgentHealth | null
  /** The control for picking another agent (a menu on the start screen, a select in Settings) */
  change: ReactNode
  /**
   * What the card says under "Your agent": the agent's name, unless `change` already shows
   * it (Settings' select), when it says what the choice is for instead.
   */
  caption?: string
}

/**
 * The agent the user works with (Settings), what state it's in, and the one thing to do next:
 * install it, sign in, try again, or nothing because it's ready.
 */
export function AgentCard({ agentId, health, change, caption }: AgentCardProps) {
  const name = health?.name ?? agentName(agentId)
  return (
    <Card as="section" aria-label="Your agent" className="flex flex-col gap-2.5 p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <GroupLabel>Your agent</GroupLabel>
          {caption ? (
            <p className="text-pretty text-small text-muted">{caption}</p>
          ) : (
            <p className="truncate font-medium">{name}</p>
          )}
        </div>
        {change}
      </div>
      {/* Keyed so a failed action's message doesn't follow the user to another agent */}
      <AgentNextStep key={agentId} name={name} health={health} />
    </Card>
  )
}

export function AgentNextStep({ name, health }: { name: string; health: AgentHealth | null }) {
  const [error, setError] = useState<string | null>(null)

  // Install and sign-in report their own failures through `health`; this catches IPC failures.
  const perform = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(readableError(err))
    }
  }

  if (!health) {
    return (
      <Step tone="danger" text={`Gui can't find ${name}. Pick another agent or add it back.`}>
        <Button onClick={() => gui.openSettings('agents')}>Agent settings</Button>
      </Step>
    )
  }

  if (!health.enabled) {
    return (
      <Step text={`${name} is turned off.`}>
        <Button onClick={() => gui.setAgentEnabled(health.id, true)}>Turn on</Button>
      </Step>
    )
  }

  // Claude Code and Codex: Gui downloads the CLI. Other agents: opens their install page.
  const install = () => void perform(() => gui.installAgent(health.id))
  const checkAgain = (
    <Button variant="ghost" onClick={() => gui.checkAgents()}>
      Check again
    </Button>
  )

  switch (health.status) {
    case 'ready':
      return <Ready binary={health.binary} />
    case 'checking':
      return <Waiting text={`Checking ${name}…`} />
    case 'signing-in':
      return <Waiting text={health.message ?? 'Waiting for you to sign in…'} />
    case 'installing':
      return <InstallProgress name={name} progress={health.progress} />
    case 'not-installed':
      if (health.install) {
        return (
          <Step text={health.message ?? `${name} isn't installed yet.`} error={error}>
            <Button variant="primary" onClick={install}>
              {health.install === 'update' ? "Install Gui's copy" : 'Install'}
            </Button>
          </Step>
        )
      }
      return (
        <Step
          text={`${name} isn't installed yet. Install it, then come back. Gui picks it up on its own.`}
          note={health.command ? `Needs the ${health.command} command on your PATH.` : undefined}
          error={error}
        >
          {health.installUrl ? (
            <Button variant="primary" onClick={install}>
              Install {name}
            </Button>
          ) : (
            checkAgain
          )}
        </Step>
      )
    case 'signed-out':
      return (
        <Step
          tone="warning"
          text={`Sign in to ${name} to start.`}
          note={health.message ?? undefined}
          error={error}
        >
          {health.signIn ? (
            <Button variant="primary" onClick={() => void perform(() => gui.signIn(health.id))}>
              {health.signIn.label}
            </Button>
          ) : (
            checkAgain
          )}
        </Step>
      )
    case 'error':
      return (
        <Step
          tone="danger"
          text={health.message ?? `${name} isn't working right now.`}
          error={error}
        >
          {/* `install` stays set after a failed download, so the same button retries it */}
          <Button variant="primary" onClick={health.install ? install : () => gui.checkAgents()}>
            Try again
          </Button>
          {health.detail && <TechnicalDetails text={health.detail} className="w-full" />}
        </Step>
      )
    default:
      return (
        <Step text={`${name} hasn't been checked yet.`}>
          <Button onClick={() => gui.checkAgents()}>Check</Button>
        </Step>
      )
  }
}

const BINARY_SOURCES: Record<AgentBinarySource, string> = {
  yours: 'Your install',
  gui: 'Installed by Gui',
  bundled: 'Bundled (dev)',
}

/** Ready, and which CLI Gui runs for it when it knows (Claude Code and Codex). */
function Ready({ binary }: { binary: AgentHealth['binary'] }) {
  return (
    <div className="flex items-center gap-2">
      <p className="flex shrink-0 items-center gap-1 text-small font-medium text-success">
        <Check className="size-3" aria-hidden="true" />
        Ready
      </p>
      {binary && (
        <p className="min-w-0 select-text truncate text-caption text-subtle tabular-nums">
          {BINARY_SOURCES[binary.source]}
          {binary.version && ` · ${binary.version}`}
        </p>
      )}
    </div>
  )
}

const megabytes = (bytes: number) => Math.round(bytes / 1e6)

function progressText(received: number, total: number | null) {
  if (received === 0) return 'Starting download…'
  if (total === null) return `Downloading ${megabytes(received)} MB`
  // The download is done; Gui is unpacking and checking it.
  if (received >= total) return 'Finishing up…'
  return `Downloading ${megabytes(received)} of ${megabytes(total)} MB`
}

function InstallProgress({ name, progress }: { name: string; progress: AgentHealth['progress'] }) {
  const received = progress?.received ?? 0
  const total = progress?.total ?? null
  // Indeterminate until bytes arrive, and throughout when the server didn't send a size.
  const fraction = received > 0 && total ? Math.min(received / total, 1) : null
  const text = progressText(received, total)

  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={`Installing ${name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
        aria-valuetext={text}
        className="h-1 overflow-hidden rounded-full bg-fill"
      >
        {fraction === null ? (
          <div className="size-full animate-pulse bg-accent" />
        ) : (
          <div
            className="size-full origin-left bg-accent transition-transform motion-reduce:transition-none"
            style={{ transform: `scaleX(${fraction})` }}
          />
        )}
      </div>
      {/* Read through the progress bar's value text */}
      <p aria-hidden="true" className="text-caption text-subtle tabular-nums">
        {text}
      </p>
    </div>
  )
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-small text-muted">
      <Spinner />
      {text}
    </p>
  )
}

interface StepProps {
  text: string
  /** Secondary detail for people who want the specifics (commands, paths) */
  note?: string
  tone?: 'warning' | 'danger'
  /** A failed action, shown under its button */
  error?: string | null
  children: ReactNode
}

function Step({ text, note, tone, error, children }: StepProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <p className="flex gap-1.5 text-pretty text-small">
          {tone && (
            <TriangleAlert
              className={
                tone === 'danger'
                  ? 'mt-px size-3.5 shrink-0 text-danger'
                  : 'mt-px size-3.5 shrink-0 text-warning'
              }
              aria-hidden="true"
            />
          )}
          <span>{text}</span>
        </p>
        {note && <p className="select-text text-pretty text-caption text-subtle">{note}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      {error && (
        <p role="alert" className="select-text text-pretty text-small text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
