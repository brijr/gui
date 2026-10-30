import { useLayoutEffect, useRef } from 'react'
import { type ChatMeta, needsSetup } from '../../../shared/types'
import { AgentNextStep } from '../agents/agent-card'
import { AgentIcon } from '../agents/agent-icon'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Card } from '../lib/surface'

/**
 * The chat's agent isn't installed or signed in: its one next step (install, sign in) right
 * above the message box, in place of an error after the user sends. Messages sent meanwhile
 * wait in the queue and go out once it's ready. Shown too when a setup the chat started
 * failed, while its messages still wait.
 */
export function shouldShowAgentSetup(meta: ChatMeta) {
  return (
    needsSetup(meta.agent) || (meta.agent?.status === 'error' && meta.queuePauseReason === 'setup')
  )
}

export function AgentSetup({ meta, className }: { meta: ChatMeta; className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const shown = shouldShowAgentSetup(meta)
  useLayoutEffect(() => {
    if (!shown && root.current?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true })
    }
  }, [shown])
  const { agent } = meta
  if (!agent) return null
  return (
    <Card ref={root} tone="inset" className={cn('flex gap-3', className)}>
      <AgentIcon agentId={agent.id} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="font-medium">Set up {agent.name}</p>
        {/* Keyed so a failed action's message doesn't follow the chat to another agent */}
        <AgentNextStep
          key={agent.id}
          name={agent.name}
          health={agent}
          onSetUp={() => gui.setUpChatAgent()}
        />
      </div>
    </Card>
  )
}
