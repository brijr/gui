import { useState } from 'react'
import type { AgentHealth, AgentId } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { ChevronRight } from '../lib/icons'
import { Card, List, ListRow } from '../lib/surface'
import { Spinner, TextButton } from '../lib/ui'
import { AgentNextStep } from './agent-card'
import { AgentIcon } from './agent-icon'

/**
 * The two agents Gui can set up with no Terminal: it downloads them, and they sign in in the
 * browser with a plan most people already pay for.
 */
const CHOICES: readonly { id: AgentId; title: string; detail: string }[] = [
  { id: 'claude', title: 'Continue with Claude', detail: 'Uses your Claude Pro or Max plan' },
  { id: 'codex', title: 'Continue with ChatGPT', detail: 'Uses your ChatGPT plan, through Codex' },
]

/**
 * Whether the start screen is still finding out if an agent works (Gui checks Claude Code,
 * Codex and the one in use on launch), so it shouldn't offer to connect one yet.
 */
export function checkingAgents(agents: AgentHealth[], agentId: AgentId) {
  return agents.some(
    (agent) =>
      agent.enabled &&
      (agent.status === 'checking' ||
        (agent.status === 'unknown' &&
          (agent.id === agentId || CHOICES.some((choice) => choice.id === agent.id)))),
  )
}

const BUSY = new Set<AgentHealth['status']>(['checking', 'installing', 'signing-in'])

/**
 * No agent works yet: pick Claude or ChatGPT, and Gui downloads its agent and opens the
 * browser to sign in, as one step. Its progress shows under the choice. Everyone else picks
 * from the full list ("Use another agent").
 */
export function ConnectAgent({
  agents,
  agentId,
  onOtherAgents,
}: {
  agents: AgentHealth[]
  agentId: AgentId
  onOtherAgents: () => void
}) {
  const [chosen, setChosen] = useState<AgentId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const healthOf = (id: AgentId) => agents.find((agent) => agent.id === id) ?? null

  const connect = async (id: AgentId) => {
    setChosen(id)
    setError(null)
    try {
      if (healthOf(id)?.enabled === false) gui.setAgentEnabled(id, true)
      if (id !== agentId) gui.setAgent(id)
      await gui.connectAgent(id)
    } catch (err) {
      setError(readableError(err))
    }
  }

  return (
    <Card as="section" aria-labelledby="connect-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id="connect-heading" className="font-semibold">
          Connect your AI
        </h2>
        <p className="text-pretty text-small text-muted">
          Gui works with the AI plan you already have. Pick one: Gui sets it up, then you sign in in
          your browser.
        </p>
      </div>
      <List aria-labelledby="connect-heading">
        {CHOICES.map((choice) => {
          const health = healthOf(choice.id)
          const busy = chosen === choice.id && health !== null && BUSY.has(health.status)
          return (
            <li key={choice.id}>
              <ListRow
                flush
                disabled={busy}
                onClick={() => void connect(choice.id)}
                leading={<AgentIcon agentId={choice.id} />}
                title={choice.title}
                detail={choice.detail}
                trailing={
                  busy ? (
                    <Spinner />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-subtle" aria-hidden="true" />
                  )
                }
              />
              {/* Where it's up to: downloading, waiting for the browser, or what went wrong */}
              {chosen === choice.id && health && health.status !== 'ready' && (
                <div className="px-3 pb-3 pl-13">
                  <AgentNextStep
                    name={health.name}
                    health={health}
                    onSetUp={() => gui.connectAgent(choice.id)}
                  />
                </div>
              )}
            </li>
          )
        })}
      </List>
      {error && <InlineError>{error}</InlineError>}
      <TextButton tone="muted" className="self-start text-small" onClick={onOtherAgents}>
        Use another agent
      </TextButton>
    </Card>
  )
}
