import { useEffect, useState } from 'react'
import type { ChatMeta, QueuedMessage, QueuePauseReason } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Clock, ImageIcon, X } from '../lib/icons'
import { Card } from '../lib/surface'
import { Button, IconButton } from '../lib/ui'
import { noteRemoveQueued } from './store'
import { isNewRow, markSeen } from './transitions'

/** Why the queue is holding back. */
const PAUSED: Record<QueuePauseReason, string> = {
  stopped: 'Paused after Stop',
  error: 'Paused after an error',
  refused: 'Paused: the agent declined',
  limit: 'Paused: the agent hit its output limit',
  untrusted: "Paused: this project isn't trusted",
  setup: 'Sends once your agent is set up',
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
    <Card tone="inset">
      <div
        className={
          paused ? 'flex items-center gap-2 border-b border-line py-1 pr-1 pl-3' : undefined
        }
      >
        {/* Mounted with the queue rather than the pause, so the pause is announced. */}
        <p
          role="status"
          className={paused ? 'min-w-0 flex-1 truncate text-small text-muted' : 'sr-only'}
        >
          {paused ? PAUSED[meta.queuePauseReason ?? 'stopped'] : ''}
        </p>
        {paused && (
          <Button size="sm" className="shrink-0" onClick={() => gui.sendQueuedNow()}>
            {meta.queuePauseReason === 'setup' ? 'Send anyway' : 'Send next'}
          </Button>
        )}
      </div>
      <ul
        data-clip
        aria-label="Queued messages"
        className="max-h-28 overflow-y-auto scroll-stable py-1"
      >
        {meta.queue.map((item) => (
          <QueuedItem key={item.id} item={item} />
        ))}
      </ul>
    </Card>
  )
}

/** One queued message; it fades in the first time it shows unless it rose from the composer. */
function QueuedItem({ item }: { item: QueuedMessage }) {
  const key = `queue:${item.id}`
  const [fresh] = useState(() => isNewRow(key))
  useEffect(() => markSeen([key]), [key])
  return (
    <li
      data-queue-item={item.id}
      className={cn(
        'flex h-7 items-center gap-2 pr-1 pl-3',
        fresh && 'animate-row-in motion-reduce:animate-row-fade',
      )}
    >
      <Clock className="size-3 shrink-0 text-subtle" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-small" title={item.prompt}>
        {item.prompt}
      </p>
      {!!item.recordings?.length && (
        <span className="shrink-0 text-caption text-subtle tabular-nums">
          {item.recordings.length} {item.recordings.length === 1 ? 'clip' : 'clips'}
        </span>
      )}
      {item.attachments.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-caption text-subtle tabular-nums">
          <ImageIcon className="size-3" aria-hidden="true" />
          {item.attachments.length}
          <span className="sr-only">{item.attachments.length === 1 ? ' image' : ' images'}</span>
        </span>
      )}
      <IconButton
        size="sm"
        label={`Remove queued message: ${excerpt(item.prompt)}`}
        title="Remove"
        icon={X}
        onClick={() => {
          noteRemoveQueued(item.id)
          gui.removeQueued(item.id)
        }}
      />
    </li>
  )
}
