import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { ChatMeta, QueuedMessage, QueuePauseReason } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Textarea } from '../lib/field'
import {
  ChevronDown,
  ChevronUp,
  Clock,
  GripVertical,
  ImageIcon,
  Pencil,
  Play,
  Reply,
  X,
} from '../lib/icons'
import { Banner, Card } from '../lib/surface'
import { Button, IconButton } from '../lib/ui'
import { noteRemoveQueued } from './store'
import { isNewRow, markSeen } from './transitions'

/** Why the queue is holding back. */
const PAUSED: Record<QueuePauseReason, string> = {
  stopped: 'Paused after Stop',
  error: 'Paused after an error',
  refused: 'Paused: the agent declined',
  limit: 'Paused: the agent hit its output limit',
  untrusted: 'Paused: this project isn’t trusted',
  setup: 'Sends once your agent is set up',
  restored: 'Waiting from before Gui closed',
}

/** Enough of a queued message to tell its buttons from the others. */
function excerpt(prompt: string) {
  const text = prompt.replace(/\s+/g, ' ').trim()
  return text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text
}

/**
 * Row actions, shown while the row is pointed at or holds the keyboard (as the archive's).
 * Laid over the end of the message rather than beside it, so while they're hidden the message
 * has the row's width; a fade on their left edge runs the text under them.
 */
const REVEAL =
  'absolute inset-y-0 right-7 flex items-center pl-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'
const REVEAL_FADE = { background: 'linear-gradient(to right, transparent, var(--surface) 16px)' }

/**
 * Messages sent while the agent was busy, oldest first, just above the composer. Each
 * starts when the turn before it is done; after Stop, an error and the like they wait for
 * "Send next". While they wait they can be edited, rearranged (drag, or the move buttons),
 * sent ahead of the rest, or removed — one by one, or all at once from the header.
 */
export function QueuedMessages({ meta, running }: { meta: ChatMeta; running: boolean }) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  if (meta.queue.length === 0) return null
  const paused = meta.queuePaused
  const endDrag = () => {
    setDragging(null)
    setOver(null)
  }
  const dropOn = (id: string, source: string) => {
    if (source && source !== id && meta.queue.some((item) => item.id === source)) {
      const index = meta.queue.findIndex((item) => item.id === id)
      if (index >= 0) gui.moveQueued(source, index)
    }
    endDrag()
  }
  const clearAll = () => {
    document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true })
    for (const item of meta.queue) noteRemoveQueued(item.id)
    gui.clearQueued()
  }
  return (
    <Card tone="inset" padding="none" className="overflow-hidden">
      {/* The reason can be long ("Paused: the agent hit its output limit"): it wraps. */}
      <Banner
        wrap
        actions={
          (meta.queue.length > 1 || paused) && (
            <>
              {meta.queue.length > 1 && (
                <Button size="sm" variant="ghost" onClick={clearAll}>
                  Clear all
                </Button>
              )}
              {paused && (
                <Button
                  size="sm"
                  onClick={() => {
                    document.querySelector<HTMLElement>('[data-composer]')?.focus()
                    gui.sendQueuedNow()
                  }}
                >
                  {meta.queuePauseReason === 'setup' ? 'Send anyway' : 'Send next'}
                </Button>
              )}
            </>
          )
        }
      >
        {/* Mounted with the queue rather than the pause, so the pause is announced. */}
        <p role="status">{paused ? PAUSED[meta.queuePauseReason ?? 'stopped'] : 'Queued'}</p>
      </Banner>
      <ul
        data-clip
        aria-label="Queued messages"
        className="max-h-28 overflow-y-auto scroll-stable py-1"
        onDragLeave={(event) => {
          const next = event.relatedTarget
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOver(null)
        }}
      >
        {meta.queue.map((item, index) => (
          <QueuedItem
            key={item.id}
            item={item}
            index={index}
            count={meta.queue.length}
            running={running}
            isDragging={dragging === item.id}
            isOver={over === item.id && dragging !== item.id}
            onDragStart={setDragging}
            onDragOver={setOver}
            onDrop={dropOn}
            onDragEnd={endDrag}
          />
        ))}
      </ul>
    </Card>
  )
}

interface QueuedItemProps {
  item: QueuedMessage
  index: number
  count: number
  running: boolean
  isDragging: boolean
  isOver: boolean
  onDragStart: (id: string) => void
  onDragOver: (id: string) => void
  onDrop: (id: string, source: string) => void
  onDragEnd: () => void
}

/** One queued message; it fades in the first time it shows unless it rose from the composer. */
function QueuedItem({
  item,
  index,
  count,
  running,
  isDragging,
  isOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: QueuedItemProps) {
  const key = `queue:${item.id}`
  const [fresh] = useState(() => isNewRow(key))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.prompt)
  const field = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  useEffect(() => markSeen([key]), [key])
  // Editing takes the keyboard; saving or cancelling gives it back to the Edit button.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (editing) {
      wasEditing.current = true
      const el = field.current
      el?.focus({ preventScroll: true })
      el?.setSelectionRange(el.value.length, el.value.length)
    } else if (wasEditing.current) {
      wasEditing.current = false
      editButton.current?.focus({ preventScroll: true })
    }
  }, [editing])

  const name = excerpt(item.prompt)
  const startEdit = () => {
    setDraft(item.prompt)
    setEditing(true)
  }
  // Empty text still sends what the message carries (images, clips), as it did when queued.
  const canSave =
    draft.trim() !== '' || item.attachments.length > 0 || (item.recordings?.length ?? 0) > 0
  const save = () => {
    if (!canSave) return
    setEditing(false)
    if (draft !== item.prompt) gui.editQueued(item.id, draft)
  }
  const onEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <li data-queue-item={item.id} className="flex items-start gap-2 py-1 pr-1 pl-3">
        <Textarea
          ref={field}
          aria-label={`Edit queued message: ${name}`}
          value={draft}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onEditKeyDown}
          className="field-sizing-content max-h-28 min-w-0 flex-1"
        />
        <div className="flex shrink-0 items-center gap-1 pt-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li
      data-queue-item={item.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', item.id)
        onDragStart(item.id)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onDragOver(item.id)
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop(item.id, event.dataTransfer.getData('text/plain'))
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative flex h-7 items-center gap-2 pr-1 pl-1.5',
        fresh && 'animate-row-in motion-reduce:animate-row-fade',
        isOver && 'bg-hover',
        isDragging && 'opacity-50',
      )}
    >
      <GripVertical
        className="size-3.5 shrink-0 cursor-grab text-subtle active:cursor-grabbing"
        aria-hidden="true"
      />
      {item.followUp ? (
        <Reply className="size-3 shrink-0 text-subtle" aria-label="Follow-up" />
      ) : (
        <Clock className="size-3 shrink-0 text-subtle" aria-hidden="true" />
      )}
      <p
        className="min-w-0 flex-1 truncate text-small"
        title={item.prompt}
        onDoubleClick={startEdit}
      >
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
      <div className={REVEAL} style={REVEAL_FADE}>
        <IconButton
          size="sm"
          label={running ? `Send queued message next: ${name}` : `Send queued message now: ${name}`}
          title={
            !running
              ? 'Send now'
              : index === 0
                ? 'Sends next, when the agent finishes'
                : 'Send after the current reply'
          }
          icon={Play}
          aria-disabled={running && index === 0}
          onClick={(event) => {
            if (!running) focusAfterQueueRemoval(event.currentTarget)
            gui.sendQueued(item.id)
          }}
        />
        <IconButton
          ref={editButton}
          size="sm"
          label={`Edit queued message: ${name}`}
          title="Edit"
          icon={Pencil}
          onClick={startEdit}
        />
        <IconButton
          size="sm"
          label={`Move queued message up: ${name}`}
          title={index === 0 ? 'Already first' : 'Move up'}
          icon={ChevronUp}
          aria-disabled={index === 0}
          onClick={() => {
            if (index > 0) gui.moveQueued(item.id, index - 1)
          }}
        />
        <IconButton
          size="sm"
          label={`Move queued message down: ${name}`}
          title={index === count - 1 ? 'Already last' : 'Move down'}
          icon={ChevronDown}
          aria-disabled={index === count - 1}
          onClick={() => {
            if (index < count - 1) gui.moveQueued(item.id, index + 1)
          }}
        />
      </div>
      <IconButton
        size="sm"
        label={`Remove queued message: ${name}`}
        title="Remove"
        icon={X}
        onClick={(event) => {
          focusAfterQueueRemoval(event.currentTarget)
          noteRemoveQueued(item.id)
          gui.removeQueued(item.id)
        }}
      />
    </li>
  )
}

function focusAfterQueueRemoval(control: HTMLElement) {
  const row = control.closest('li')
  const neighbor = row?.nextElementSibling ?? row?.previousElementSibling
  ;(
    neighbor?.querySelector<HTMLElement>('[aria-label^="Edit queued message:"]') ??
    document.querySelector<HTMLElement>('[data-composer]')
  )?.focus({ preventScroll: true })
}
