import { useEffect, useState } from 'react'
import { type AgentId, agentName } from '../../../shared/types'
import { gui } from '../lib/api'
import { InlineError } from '../lib/field'
import { Button } from '../lib/ui'

const NOT_READY = 'The chat isn’t ready yet. Try again in a moment.'
/** How long a compact button says it couldn't act before it reads as itself again. */
const NOTICE_MS = 4000

/**
 * Hands a failed start to the chat's agent, with why it failed and the dev server's logs:
 * it works out what's wrong, fixes it, and starts the app again. While it's asking, it shows
 * a spinner and takes no second click; when there's no chat to ask, it says so: under the
 * button in a card, or in its own label in a compact row.
 */
export function FixStartupButton({
  agentId,
  variant = 'primary',
  size,
}: {
  agentId: AgentId
  variant?: 'primary' | 'secondary'
  size?: 'sm' | 'md'
}) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const compact = size === 'sm'

  useEffect(() => {
    if (!failed || !compact) return
    const timer = setTimeout(() => setFailed(false), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [failed, compact])

  const fix = async () => {
    if (pending) return
    setPending(true)
    setFailed(false)
    try {
      if (!(await gui.fixStartup())) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  const button = (
    <Button
      variant={variant}
      size={size}
      loading={pending}
      title={failed ? NOT_READY : undefined}
      onClick={() => void fix()}
    >
      {compact && failed ? 'Chat not ready' : `Fix with ${agentName(agentId)}`}
    </Button>
  )
  if (compact)
    return (
      <>
        {button}
        {failed && (
          <span role="alert" className="sr-only">
            {NOT_READY}
          </span>
        )}
      </>
    )
  return (
    <>
      {button}
      {failed && <InlineError className="basis-full">{NOT_READY}</InlineError>}
    </>
  )
}
