import { Clock, ImageIcon, X } from 'lucide-react'
import type { ChatMeta, QueuePauseReason } from '../../../shared/types'
import { gui } from '../lib/api'

/** Why the queue is holding back. */
const PAUSED: Record<QueuePauseReason, string> = {
  stopped: 'Paused after Stop',
  error: 'Paused after an error',
  refused: 'Paused: the agent declined',
  limit: 'Paused: the agent hit its output limit',
  untrusted: "Paused: this project isn't trusted",
}

/** Enough of a queued message to tell its remove button from the others. */
function excerpt(prompt: string) {
  const text = prompt.replace(/\s+/g, ' ').trim()
  return text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text
}

/**
 * Messages sent while the agent was busy, oldest first, just above the composer. Each
 * starts when the turn before it is done; after Stop, an error and the like they wait for
 * "Send next".
 */
export function QueuedMessages({ meta }: { meta: ChatMeta }) {
  if (meta.queue.length === 0) return null
  const paused = meta.queuePaused
  return (
    <div className="mb-2 rounded-lg border border-line bg-surface">
      <div
        className={
          paused ? 'flex items-center gap-2 border-b border-line py-1 pr-1 pl-2.5' : undefined
        }
      >
        {/* Mounted with the queue rather than the pause, so the pause is announced. */}
        <p
          role="status"
          className={paused ? 'min-w-0 flex-1 truncate text-[12px] text-muted' : 'sr-only'}
        >
          {paused ? PAUSED[meta.queuePauseReason ?? 'stopped'] : ''}
        </p>
        {paused && (
          <button
            type="button"
            onClick={() => gui.sendQueuedNow()}
            className="h-6 shrink-0 rounded-md border border-line-strong bg-raised px-2 text-[12px] font-medium hover:bg-hover"
          >
            Send next
          </button>
        )}
      </div>
      <ul aria-label="Queued messages" className="max-h-28 overflow-y-auto py-1">
        {meta.queue.map((item) => (
          <li key={item.id} className="flex h-6 items-center gap-2 pr-1 pl-2.5">
            <Clock className="size-3 shrink-0 text-subtle" aria-hidden="true" />
            <p className="min-w-0 flex-1 truncate text-[12px]" title={item.prompt}>
              {item.prompt}
            </p>
            {item.attachments.length > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-subtle tabular-nums">
                <ImageIcon className="size-3" aria-hidden="true" />
                {item.attachments.length}
                <span className="sr-only">
                  {item.attachments.length === 1 ? ' image' : ' images'}
                </span>
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove queued message: ${excerpt(item.prompt)}`}
              title="Remove"
              onClick={() => gui.removeQueued(item.id)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
