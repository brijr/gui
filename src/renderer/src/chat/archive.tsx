import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { agentName, type ChatSummary } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { readableError } from '../lib/errors'
import { InlineError, Input } from '../lib/field'
import { Pencil, Trash2 } from '../lib/icons'
import { motionMs, usePresence } from '../lib/motion'
import {
  GroupLabel,
  Popover,
  PopoverNote,
  type PopoverPlacement,
  PopoverSearch,
  placePopover,
} from '../lib/surface'
import { timeAgo } from '../lib/time'
import { Button, IconButton, Spinner } from '../lib/ui'

/** Lists longer than this get a filter field. */
const FILTER_AFTER = 8

/**
 * The project's archived chats, to reopen, rename or delete: a popover under `anchor` (the
 * header's More button, whose menu opens it).
 */
export function ArchivePopover({
  open,
  anchor,
  onClose,
}: {
  open: boolean
  anchor: React.RefObject<HTMLButtonElement | null>
  onClose: (refocus: boolean) => void
}) {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  const shown = usePresence(open, motionMs('--motion-exit'))
  const listId = useId()
  // Placed under the button each time it opens.
  useEffect(() => {
    if (open && anchor.current) setPlacement(placePopover(anchor.current))
  }, [open, anchor])
  if (!shown || !placement) return null
  return (
    <ArchiveList
      key={`${placement.left},${placement.top},${placement.bottom}`}
      id={listId}
      open={open}
      placement={placement}
      button={anchor}
      onClose={onClose}
    />
  )
}

/** Every typed word appears in the chat's title or first message, ignoring case. */
function matches(chat: ChatSummary, words: string[]) {
  const text = `${chat.title ?? ''} ${chat.prompt}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

interface ArchiveListProps {
  id: string
  open: boolean
  placement: PopoverPlacement
  button: React.RefObject<HTMLButtonElement | null>
  onClose: (refocus: boolean) => void
}

function ArchiveList({ id, open, placement, button, onClose }: ArchiveListProps) {
  const root = useRef<HTMLDivElement>(null)
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** The chat being opened, renamed, or asked about deleting; one at a time. */
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const reload = () =>
    gui.listChats().then(setChats, (err: unknown) => {
      setChats([])
      setError(readableError(err))
    })

  // On each opening: reopened while still closing, it's the same list, which may be stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read when it opens
  useEffect(() => {
    if (open) void reload()
  }, [open])

  // On opening, and again once the list is in: its filter field, or its first chat.
  const loaded = chats !== null
  useEffect(() => {
    if (open && loaded)
      (
        root.current?.querySelector<HTMLElement>('ul input, input, ul button') ?? root.current
      )?.focus()
  }, [open, loaded])

  // A click elsewhere in the chat, or anywhere outside it (the view loses focus), closes it;
  // so does a resize, which moves the button.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (root.current?.contains(target) || button.current?.contains(target)) return
      onClose(false)
    }
    const dismiss = () => onClose(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, button, onClose])

  const act = async (chatId: string, action: () => Promise<void>) => {
    setBusy(chatId)
    setError(null)
    try {
      await action()
      return true
    } catch (err) {
      setError(readableError(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  const reopen = async (chat: ChatSummary) => {
    if (await act(chat.id, () => gui.openChat(chat.id))) onClose(false)
  }

  const rename = async (chat: ChatSummary, title: string) => {
    setRenaming(null)
    // Left as it was shown: nothing to save.
    if (title.replace(/\s+/g, ' ').trim() === (chat.title ?? chat.prompt)) return
    if (await act(chat.id, () => gui.renameChat(chat.id, title))) await reload()
  }

  const remove = async (chat: ChatSummary) => {
    setDeleting(null)
    const rows = root.current?.querySelectorAll<HTMLElement>('li')
    const index = shown.findIndex((item) => item.id === chat.id)
    ;(
      rows?.[index + 1]?.querySelector<HTMLElement>('button') ??
      rows?.[index - 1]?.querySelector<HTMLElement>('button') ??
      root.current
    )?.focus()
    if (await act(chat.id, () => gui.deleteChat(chat.id))) await reload()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    // Esc backs out of a rename or a delete first.
    if (renaming || deleting) {
      setRenaming(null)
      setDeleting(null)
      return
    }
    onClose(true)
  }

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = chats?.filter((chat) => matches(chat, words)) ?? []
  const filterable = (chats?.length ?? 0) > FILTER_AFTER

  return createPortal(
    <Popover
      ref={root}
      id={id}
      open={open}
      role="dialog"
      aria-label="Archived chats"
      onKeyDown={onKeyDown}
      tabIndex={-1}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.relatedTarget !== document.body &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          onClose(false)
      }}
      placement={placement}
    >
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-line px-3 pt-2.5 pb-2">
        <GroupLabel as="h2">Archived chats</GroupLabel>
      </div>
      {filterable && (
        <PopoverSearch
          aria-label="Filter archived chats"
          placeholder="Filter chats…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {chats === null ? (
        <PopoverNote loading>Loading…</PopoverNote>
      ) : chats.length === 0 ? (
        <PopoverNote>No archived chats yet.</PopoverNote>
      ) : shown.length === 0 ? (
        <PopoverNote>No chats match</PopoverNote>
      ) : (
        <ul className="min-h-0 overflow-y-auto scroll-stable overscroll-contain p-1">
          {shown.map((chat) => (
            <ArchivedRow
              key={chat.id}
              chat={chat}
              busy={busy === chat.id}
              disabled={busy !== null}
              renaming={renaming === chat.id}
              deleting={deleting === chat.id}
              onOpen={() => void reopen(chat)}
              onStartRename={() => {
                setDeleting(null)
                setRenaming(chat.id)
              }}
              onRename={(title) => void rename(chat, title)}
              onCancelRename={() => setRenaming(null)}
              onStartDelete={() => {
                setRenaming(null)
                setDeleting(chat.id)
              }}
              onDelete={() => void remove(chat)}
              onCancelDelete={() => setDeleting(null)}
            />
          ))}
        </ul>
      )}
      {error && (
        <InlineError className="shrink-0 border-t border-line px-3 py-2">{error}</InlineError>
      )}
    </Popover>,
    document.body,
  )
}

interface ArchivedRowProps {
  chat: ChatSummary
  busy: boolean
  disabled: boolean
  renaming: boolean
  deleting: boolean
  onOpen: () => void
  onStartRename: () => void
  onRename: (title: string) => void
  onCancelRename: () => void
  onStartDelete: () => void
  onDelete: () => void
  onCancelDelete: () => void
}

function ArchivedRow({
  chat,
  busy,
  disabled,
  renaming,
  deleting,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onStartDelete,
  onDelete,
  onCancelDelete,
}: ArchivedRowProps) {
  const row = useRef<HTMLLIElement>(null)
  const wasEditing = useRef(false)
  useLayoutEffect(() => {
    if (deleting) row.current?.querySelector<HTMLButtonElement>('button')?.focus()
    else if (
      wasEditing.current &&
      !renaming &&
      (document.activeElement === document.body || !!row.current?.contains(document.activeElement))
    )
      row.current?.querySelector<HTMLButtonElement>('button')?.focus()
    wasEditing.current = renaming || deleting
  }, [renaming, deleting])
  const name = chat.title ?? chat.prompt
  const detail = `${agentName(chat.agentId)} · ${chat.turns === 1 ? '1 message' : `${chat.turns} messages`} · ${timeAgo(chat.lastAt)}`

  if (renaming) {
    return (
      <li ref={row} className="px-1 py-1">
        <RenameField
          name={name}
          initial={chat.title ?? chat.prompt}
          onDone={onRename}
          onCancel={onCancelRename}
        />
      </li>
    )
  }

  if (deleting) {
    return (
      <li ref={row} className="flex items-center gap-2 rounded-md bg-hover px-2 py-1.5">
        <span className="min-w-0 flex-1 text-small text-fg">Delete this chat for good?</span>
        <Button size="sm" variant="ghost" onClick={onCancelDelete}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" aria-label={`Delete ${name}`} onClick={onDelete}>
          Delete
        </Button>
      </li>
    )
  }

  return (
    <li
      ref={row}
      className="group flex items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-hover focus-within:bg-hover"
    >
      <button
        type="button"
        title={`Open “${name}”`}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) onOpen()
        }}
        // The focus ring inside the row, where the list's edge can't clip it.
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left focus-visible:-outline-offset-2 disabled:opacity-60"
      >
        <span className="w-full truncate text-small text-fg">{name}</span>
        <span className="w-full truncate text-caption text-subtle">{detail}</span>
      </button>
      {busy ? (
        <Spinner className="mx-1.5 text-muted" />
      ) : (
        <div
          className={cn(
            'flex shrink-0 items-center opacity-0 transition-opacity',
            'group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          <IconButton
            size="sm"
            label={`Rename ${name}`}
            title="Rename"
            icon={Pencil}
            aria-disabled={disabled}
            onClick={onStartRename}
          />
          <IconButton
            size="sm"
            label={`Delete ${name}`}
            title="Delete"
            icon={Trash2}
            aria-disabled={disabled}
            onClick={onStartDelete}
          />
        </div>
      )}
    </li>
  )
}

/** Enter or leaving the field saves; Esc cancels. Either happens once. */
function RenameField({
  name,
  initial,
  onDone,
  onCancel,
}: {
  name: string
  initial: string
  onDone: (title: string) => void
  onCancel: () => void
}) {
  const finished = useRef(false)
  const finish = (save: boolean, title: string) => {
    if (finished.current) return
    finished.current = true
    if (save) onDone(title)
    else onCancel()
  }
  return (
    <Input
      autoFocus
      aria-label={`Name for ${name}`}
      defaultValue={initial}
      maxLength={120}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') finish(true, event.currentTarget.value)
        if (event.key === 'Escape') {
          event.stopPropagation()
          finish(false, '')
        }
      }}
      onBlur={(event) => finish(true, event.currentTarget.value)}
    />
  )
}
