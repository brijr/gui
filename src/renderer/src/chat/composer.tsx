import { ArrowUp, Crosshair, ImagePlus, Square, TriangleAlert, X } from 'lucide-react'
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ChatMeta } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { IconButton, Spinner, TechnicalDetails } from '../lib/ui'
import { ImageError, imageFiles, MAX_IMAGES, prepareImage } from './images'
import { addAttachments, removeAttachments, setDraft, useChat } from './store'
import { elementLabel } from './turn-view'

const NOTICE_MS = 5000

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

export function Composer({ meta, running }: { meta: ChatMeta; running: boolean }) {
  // The draft lives in the store: docking, floating and minimizing remount this component.
  const text = useChat((s) => s.draft)
  const attachments = useChat((s) => s.attachments)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  /** Images still being downscaled; a ref so overlapping pastes count each other. */
  const processing = useRef(0)
  const [pending, setPending] = useState(0)
  const [dropping, setDropping] = useState(false)
  /** Why a file wasn't attached; quiet and short-lived. */
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => grat.onChatFocus(() => input.current?.focus()), [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const canSend = (text.trim() !== '' || attachments.length > 0) && pending === 0

  /** One at a time, in order: decoding several large images at once can spike memory. */
  const attach = async (files: Iterable<File>) => {
    const { images, rejected } = imageFiles(files)
    const room = Math.max(
      0,
      MAX_IMAGES - useChat.getState().attachments.length - processing.current,
    )
    const accepted = images.slice(0, room)
    setNotice(images.length > room ? `Up to ${MAX_IMAGES} images per message.` : (rejected ?? null))
    processing.current += accepted.length
    setPending(processing.current)
    for (const file of accepted) {
      try {
        addAttachments([await prepareImage(file)])
      } catch (error) {
        setNotice(error instanceof ImageError ? error.message : `Couldn't attach ${file.name}.`)
      } finally {
        processing.current -= 1
        setPending(processing.current)
      }
    }
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSend || running) return
    const sent = attachments
    const images = sent.map(({ name, mimeType, data, thumbnail }) => ({
      name,
      mimeType,
      data,
      thumbnail,
    }))
    // Keep the draft unless main actually started the turn.
    if (await grat.send(text, images)) {
      setDraft('')
      // Only what went out: an image attached while sending stays for the next message.
      removeAttachments(sent.map((image) => image.id))
      setNotice(null)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape' && meta.selection) {
      grat.clearSelection()
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    if (imageFiles(files).images.length === 0) return
    // Rich copies carry text along with the image; paste it as usual. Finder's copied
    // file names (one per line) are the exception: they'd only clutter the message.
    const names = new Set(files.map((file) => file.name))
    const lines = event.clipboardData.getData('text/plain').split(/[\r\n]+/)
    if (lines.every((line) => !line.trim() || names.has(line.trim()))) event.preventDefault()
    void attach(files)
  }

  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }

  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDropping(false)
  }

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDropping(false)
    void attach([...event.dataTransfer.files])
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="shrink-0 border-t border-line p-2"
    >
      <AgentStatus meta={meta} />
      {meta.problems.length > 0 && <ProblemsBar meta={meta} running={running} />}
      {meta.selectionError && (
        <p className="mb-2 select-text px-1 text-[12px] text-danger">{meta.selectionError}</p>
      )}
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
      {notice && (
        <p role="status" className="mb-2 px-1 text-[12px] text-muted">
          {notice}
        </p>
      )}
      <div
        className={cn(
          'rounded-lg border border-line-strong bg-raised transition-colors focus-within:border-accent',
          dropping && 'border-accent bg-accent-soft',
        )}
      >
        {(attachments.length > 0 || pending > 0) && (
          <ul aria-label="Attached images" className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((image) => (
              <li key={image.id} className="relative">
                <img
                  src={image.thumbnail}
                  alt={image.name}
                  title={image.name}
                  className="size-12 rounded-md border border-line bg-canvas object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  title="Remove"
                  onClick={() => removeAttachments([image.id])}
                  className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-line-strong bg-raised text-muted hover:text-fg"
                >
                  <X className="size-2.5" aria-hidden="true" />
                </button>
              </li>
            ))}
            {pending > 0 && (
              <li className="flex size-12 items-center justify-center rounded-md border border-line bg-surface text-subtle">
                <Spinner className="size-3" />
                <span className="sr-only">Preparing image</span>
              </li>
            )}
          </ul>
        )}
        <textarea
          ref={input}
          // Empty, ⌘Z here undoes the agent's last change instead of typing.
          data-undo-passthrough=""
          value={text}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label={`Message ${meta.agentName}`}
          placeholder={
            meta.selection || attachments.length > 0
              ? 'Describe the change…'
              : `Ask ${meta.agentName}…`
          }
          className="field-sizing-content block max-h-40 min-h-9 w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-[13px] text-fg outline-none focus-visible:outline-none placeholder:text-subtle"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <IconButton label="Select element (⇧⌘C)" onClick={() => grat.toggleSelect()}>
            <Crosshair className="size-3.5" />
          </IconButton>
          <IconButton
            label="Attach images"
            disabled={attachments.length + pending >= MAX_IMAGES}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus className="size-3.5" />
          </IconButton>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              // Cleared so choosing the same file again still fires a change.
              event.target.value = ''
              void attach(files)
            }}
          />
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
              disabled={!canSend}
              className={cn(
                'flex size-7 items-center justify-center rounded-md transition-colors',
                canSend ? 'bg-accent text-accent-fg hover:opacity-90' : 'bg-hover text-subtle',
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

function ProblemsBar({ meta, running }: { meta: ChatMeta; running: boolean }) {
  const count = meta.problems.length
  const latest = meta.problems.at(-1)
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface py-1.5 pr-1.5 pl-2.5">
      <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium">
          {count === 1 ? '1 error' : `${count} errors`} in the preview
        </p>
        {latest && (
          <p className="truncate font-mono text-[10.5px] text-subtle" title={latest.message}>
            {latest.message.split('\n')[0]}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={running}
        onClick={() => void grat.fixProblems()}
        className="h-7 shrink-0 rounded-md border border-line-strong bg-raised px-2.5 text-[12px] font-medium hover:bg-hover disabled:opacity-40"
      >
        Fix
      </button>
    </div>
  )
}

function SelectionLabel({ meta }: { meta: ChatMeta }) {
  const selection = meta.selection
  if (!selection) return null
  const { name, where } = elementLabel(selection)
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-[12px]">
        <span className="font-medium">{name}</span>
        {selection.text && <span className="text-muted"> {selection.text.slice(0, 60)}</span>}
      </p>
      <p
        className="truncate font-mono text-[10.5px] text-subtle"
        title={selection.source?.file ?? selection.selector}
      >
        {where ?? selection.selector}
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
      <div className="mb-2 flex flex-col gap-1 px-1">
        <p className="select-text text-[12px] text-danger">
          {meta.error} <span className="text-muted">Send a message to retry.</span>
        </p>
        {meta.errorDetail && <TechnicalDetails text={meta.errorDetail} />}
      </div>
    )
  }
  return null
}
