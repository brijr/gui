import { useEffect, useState } from 'react'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { Card } from '../lib/surface'
import { PromptButton, Spinner } from '../lib/ui'
import { sendStarter } from './intents'

/** How long a sent starter waits to see the agent start before the starters come back. */
const SENT_WAIT_MS = 10_000

/** Prompts for an empty canvas: the kinds of thing a board is good for. */
const STARTERS = [
  'Kiln, a booking app for pottery studios',
  'Three different pricing page options, side by side',
  'A mobile onboarding flow in three screens',
  'A dashboard for a small fitness studio',
]

/**
 * An empty canvas: what to ask for, rather than a blank void. A starter goes to the chat once:
 * the starters wait while it's sending and while the agent works on it.
 */
export function EmptyBoard({ working }: { working: boolean }) {
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Sent, until the agent is seen working on it: the tab's status comes a moment later. If
  // it never does (the message waits for setup), the starters come back after a while.
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (working) setSent(false)
    if (!sent || working) return
    const timer = setTimeout(() => setSent(false), SENT_WAIT_MS)
    return () => clearTimeout(timer)
  }, [sent, working])
  const busy = working || sent || sending !== null
  const start = async (prompt: string) => {
    if (busy) return
    setSending(prompt)
    setError(null)
    try {
      if (await sendStarter(prompt)) setSent(true)
      else setError('Gui couldn’t send that to your agent. Try again, or ask in the chat.')
    } catch (err) {
      setError(readableError(err))
    } finally {
      setSending(null)
    }
  }
  if (working || sent) {
    // The agent has it: only say so. The starters can't be used until it's done.
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
        <p role="status" className="flex items-center gap-2 text-muted">
          <Spinner />
          Your agent is adding frames…
        </p>
      </div>
    )
  }
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
      <Card
        padding="canvas"
        className="pointer-events-auto flex w-fit max-w-md flex-col gap-4"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">Start your canvas</h2>
          <p className="text-pretty text-muted">Ask for a page or a few versions to compare.</p>
        </div>
        <ul aria-label="Ideas to start with" className="flex flex-col items-start gap-1.5">
          {STARTERS.map((prompt) => (
            <li key={prompt} className="max-w-full">
              <PromptButton
                loading={sending === prompt}
                disabled={busy}
                onClick={() => void start(prompt)}
              >
                {prompt}
              </PromptButton>
            </li>
          ))}
        </ul>
        {error && <InlineError>{error}</InlineError>}
      </Card>
    </div>
  )
}
