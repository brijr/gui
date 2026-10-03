import { ArrowUp, Crosshair, Square, X } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { ChatMeta } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { IconButton, Spinner } from '../lib/ui'
import { elementLabel } from './turn-view'

export function Composer({ meta, running }: { meta: ChatMeta; running: boolean }) {
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => grat.onChatFocus(() => input.current?.focus()), [])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!text.trim() || running) return
    void grat.send(text)
    setText('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape' && meta.selection) {
      grat.clearSelection()
    }
  }

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-line p-2">
      <AgentStatus meta={meta} />
      {meta.selection && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface p-1.5">
          {meta.selection.screenshot ? (
            <img
              src={meta.selection.screenshot}
              alt=""
              className="size-9 shrink-0 rounded border border-line bg-canvas object-contain"
            />
          ) : (
            <Crosshair className="size-4 shrink-0 text-muted" aria-hidden="true" />
          )}
          <SelectionLabel meta={meta} />
          <IconButton label="Remove selection" onClick={() => grat.clearSelection()}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      )}
      <div className="rounded-lg border border-line-strong bg-raised focus-within:border-accent">
        <textarea
          ref={input}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={`Message ${meta.agentName}`}
          placeholder={meta.selection ? 'Describe the change…' : `Ask ${meta.agentName}…`}
          className="field-sizing-content block max-h-40 min-h-9 w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-[13px] text-fg outline-none focus-visible:outline-none placeholder:text-subtle"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <IconButton label="Select element (⇧⌘C)" onClick={() => grat.toggleSelect()}>
            <Crosshair className="size-3.5" />
          </IconButton>
          <span className="ml-auto" />
          {running ? (
            <button
              type="button"
              aria-label="Stop (⌘.)"
              title="Stop (⌘.)"
              onClick={() => grat.cancel()}
              className="flex size-7 items-center justify-center rounded-md bg-fg text-raised hover:opacity-85"
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              title="Send (↵)"
              disabled={!text.trim()}
              className={cn(
                'flex size-7 items-center justify-center rounded-md transition-colors',
                text.trim() ? 'bg-accent text-accent-fg hover:opacity-90' : 'bg-hover text-subtle',
              )}
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

function SelectionLabel({ meta }: { meta: ChatMeta }) {
  const selection = meta.selection
  if (!selection) return null
  const { tag, where } = elementLabel(selection)
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate font-mono text-[11.5px]">
        {tag}
        {selection.text && (
          <span className="font-sans text-muted"> {selection.text.slice(0, 60)}</span>
        )}
      </p>
      <p className="truncate font-mono text-[10.5px] text-subtle" title={selection.source?.file}>
        {where ?? selection.selector}
        {selection.source?.approximate && ' (approx.)'}
      </p>
    </div>
  )
}

function AgentStatus({ meta }: { meta: ChatMeta }) {
  if (meta.status === 'starting') {
    return (
      <p className="mb-2 flex items-center gap-2 px-1 text-[12px] text-muted">
        <Spinner className="size-2.5" />
        Starting {meta.agentName}…
      </p>
    )
  }
  if (meta.status === 'error' && meta.error) {
    return (
      <p className="mb-2 select-text px-1 text-[12px] text-danger">
        {meta.error} Send a message to retry.
      </p>
    )
  }
  return null
}
