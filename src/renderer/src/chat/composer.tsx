import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { type ChatMeta, isRegion, type Picked, type Problem } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { TechnicalDetails } from '../lib/disclosure'
import {
  ArrowUp,
  Crop,
  ImagePlus,
  Info,
  MousePointer2,
  Square,
  TriangleAlert,
  X,
} from '../lib/icons'
import { Card, Thumbnail } from '../lib/surface'
import { Button, IconButton, Spinner } from '../lib/ui'
import { AutoToggle } from './auto-toggle'
import { useCommandMenu } from './command-menu'
import { ImageError, imageFiles, MAX_IMAGES, prepareImage } from './images'
import { ModelButton } from './model-picker'
import { QueuedMessages } from './queue'
import { RecordingClip } from './recording-clip'
import {
  addAttachments,
  noteSend,
  removeAttachments,
  removeRecordings,
  setDraft,
  setNotice,
  settleSend,
  useChat,
} from './store'
import { pickLabel } from './turn-view'

const NOTICE_MS = 5000

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

export function Composer({ meta, running }: { meta: ChatMeta; running: boolean }) {
  // The draft lives in the store: docking, floating and minimizing remount this component.
  const text = useChat((s) => s.draft)
  const attachments = useChat((s) => s.attachments)
  const recordings = useChat((s) => s.recordings)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  /** Images still being downscaled; a ref so overlapping pastes count each other. */
  const processing = useRef(0)
  const [pending, setPending] = useState(0)
  const [dropping, setDropping] = useState(false)
  /** Why a file wasn't attached; quiet and short-lived. In the store, as main can set it too. */
  const notice = useChat((s) => s.notice)

  useEffect(() => gui.onChatFocus(() => input.current?.focus()), [])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const canSend =
    (text.trim() !== '' || attachments.length > 0 || recordings.length > 0) && pending === 0

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

  /** A send awaiting main; main queues while busy, so a repeat Enter would queue it twice. */
  const sending = useRef(false)

  // While the agent works, this queues the message (meta.queue) instead of starting a turn.
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSend || sending.current) return
    const sent = attachments
    const clips = recordings.map((clip) => clip.id)
    const images = sent.map(({ name, mimeType, data, thumbnail }) => ({
      name,
      mimeType,
      data,
      thumbnail,
    }))
    sending.current = true
    // Its turn (or queued message) rises out of the composer when main reports it.
    noteSend(
      text,
      sent.map((image) => image.id),
      clips,
    )
    try {
      // Keep the draft unless main took it (started the turn or queued it). Only what went
      // out clears: an image attached while sending stays for the next message.
      const accepted = await gui.send(text, images, clips)
      settleSend(
        accepted,
        text,
        sent.map((image) => image.id),
        clips,
      )
      if (accepted) setNotice(null)
    } finally {
      sending.current = false
    }
  }

  const commands = useCommandMenu({
    text,
    commands: meta.commands,
    setText: setDraft,
    send: () => void submit(),
  })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commands.onKeyDown(event)) return
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape' && meta.selection.length > 0) {
      gui.clearSelection()
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
      className="flex shrink-0 flex-col gap-2 border-t border-line p-2"
    >
      <AgentStatus meta={meta} />
      {meta.problems.length > 0 && <ProblemsBar meta={meta} running={running} />}
      <QueuedMessages meta={meta} />
      {meta.selectionError && <Line tone="error">{meta.selectionError}</Line>}
      {meta.selection.length > 0 && <Selection selection={meta.selection} />}
      {notice && (
        <Line tone="info" role="status">
          {notice}
        </Line>
      )}
      {commands.element}
      <div
        className={cn(
          'rounded-lg border border-line-strong bg-raised transition-colors focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
          dropping && 'border-accent bg-accent-soft',
        )}
      >
        {(attachments.length > 0 || pending > 0) && (
          <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-2 pt-2">
            {attachments.map((image) => (
              <li key={image.id}>
                <Thumbnail
                  src={image.thumbnail}
                  alt={image.name}
                  title={image.name}
                  onRemove={() => removeAttachments([image.id])}
                  removeLabel={`Remove ${image.name}`}
                />
              </li>
            ))}
            {pending > 0 && (
              <li>
                <Thumbnail>
                  <Spinner />
                  <span className="sr-only">Preparing image</span>
                </Thumbnail>
              </li>
            )}
          </ul>
        )}
        {recordings.length > 0 && (
          <fieldset aria-label="Attached recordings" className="flex flex-col gap-2 px-2 pt-2">
            {recordings.map((clip) => (
              <RecordingClip
                key={clip.id}
                clip={clip}
                onRemove={() => removeRecordings([clip.id], true)}
              />
            ))}
          </fieldset>
        )}
        <textarea
          ref={input}
          // Empty, ⌘Z here undoes the agent's last change instead of typing.
          data-undo-passthrough=""
          // ⌘L hides the chat from here (main checks for it).
          data-composer=""
          value={text}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          {...commands.inputProps}
          aria-label={`Message ${meta.agentName}`}
          placeholder={
            running
              ? 'Queue a message…'
              : meta.selection.length > 0 || attachments.length > 0
                ? 'Describe the change…'
                : `Ask ${meta.agentName}…`
          }
          className="field-sizing-content block max-h-40 min-h-9 w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-fg outline-none focus-visible:outline-none placeholder:text-subtle"
        />
        {/* A container: in a narrow panel, Auto and the model button get more compact. */}
        <div className="@container flex items-center gap-1 px-1.5 pb-1.5">
          <IconButton
            label="Select element"
            shortcut="selectElement"
            icon={MousePointer2}
            pressed={meta.selecting}
            // Nothing to pick until the local app shows (as the toolbar's Select).
            disabled={!meta.canSelect && !meta.selecting}
            onClick={() => gui.toggleSelect()}
          />
          <IconButton
            label="Attach images"
            icon={ImagePlus}
            disabled={attachments.length + pending >= MAX_IMAGES}
            onClick={() => picker.current?.click()}
          />
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
          <AutoToggle meta={meta} />
          <span className="ml-auto" />
          {meta.models && <ModelButton models={meta.models} />}
          {/* While the agent works, a draft can still go out: it joins the queue. */}
          {(!running || canSend) && (
            <IconButton
              type="submit"
              variant="primary"
              label={running ? 'Queue message' : 'Send'}
              title={running ? 'Queue (↵)' : 'Send (↵)'}
              icon={ArrowUp}
              disabled={!canSend}
            />
          )}
          {/* Last, so it stays put while a draft's queue button comes and goes. */}
          {running && (
            <IconButton
              variant="secondary"
              label="Stop"
              shortcut="stop"
              icon={Square}
              filled
              onClick={() => gui.cancel()}
            />
          )}
        </div>
      </div>
    </form>
  )
}

/** Where the errors are: the preview's console, the dev server's output, or both. */
function problemsTitle(problems: Problem[]) {
  const errors = problems.length === 1 ? '1 error' : `${problems.length} errors`
  const fromServer = problems.filter((problem) => problem.source === 'server').length
  if (fromServer === 0) return `${errors} in the preview`
  if (fromServer === problems.length) return `${errors} from the dev server`
  return `${errors} in the preview and dev server`
}

function ProblemsBar({ meta, running }: { meta: ChatMeta; running: boolean }) {
  const latest = meta.problems.at(-1)
  return (
    <Card tone="inset" className="flex items-center gap-2 py-1.5 pr-1.5 pl-2.5">
      <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-small font-medium">{problemsTitle(meta.problems)}</p>
        {latest && (
          <p className="truncate font-mono text-caption text-subtle" title={latest.message}>
            {latest.message.split('\n')[0]}
          </p>
        )}
      </div>
      <Button
        size="sm"
        className="shrink-0"
        disabled={running}
        onClick={() => void gui.fixProblems()}
      >
        Fix
      </Button>
    </Card>
  )
}

/**
 * What's picked for the next message, in the order it was picked (numbered as the preview
 * numbers it, when there are several). Pointing at one shows which it is in the page.
 */
function Selection({ selection }: { selection: Picked[] }) {
  const several = selection.length > 1
  return (
    <Card tone="inset" className="max-h-36 overflow-y-auto">
      <ul
        aria-label={several ? `${selection.length} picked` : 'Picked'}
        className="divide-y divide-line"
      >
        {selection.map((picked, i) => (
          <li
            key={picked.id}
            onPointerEnter={() => gui.hoverSelection(picked.id)}
            onPointerLeave={() => gui.hoverSelection(null)}
            className="flex items-center gap-2 p-1.5"
          >
            <div className="relative shrink-0">
              {picked.screenshot ? (
                <Thumbnail src={picked.screenshot} size="sm" fit="contain" />
              ) : (
                <Thumbnail size="sm">
                  {isRegion(picked) ? (
                    <Crop className="size-3.5" aria-hidden="true" />
                  ) : (
                    <MousePointer2 className="size-3.5" aria-hidden="true" />
                  )}
                </Thumbnail>
              )}
              {several && (
                <span className="absolute -top-1 -left-1 flex size-4 items-center justify-center rounded-full bg-accent text-caption font-medium text-accent-fg tabular-nums">
                  {i + 1}
                </span>
              )}
            </div>
            <PickedLabel picked={picked} />
            <IconButton
              size="sm"
              label={several ? `Remove ${pickLabel(picked).name}` : 'Remove selection'}
              title="Remove"
              icon={X}
              onClick={() => {
                gui.hoverSelection(null)
                gui.removeSelection(picked.id)
              }}
            />
          </li>
        ))}
      </ul>
    </Card>
  )
}

function PickedLabel({ picked }: { picked: Picked }) {
  const { name, detail, where, title } = pickLabel(picked)
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-small">
        <span className="font-medium">{name}</span>
        {detail && <span className="text-muted"> {detail}</span>}
      </p>
      {where && (
        <p className="truncate font-mono text-caption text-subtle" title={title}>
          {where}
        </p>
      )}
    </div>
  )
}

/** A line above the message box: an icon in a 14px slot, then small text. */
function Line({
  tone,
  role,
  children,
}: {
  tone: 'info' | 'error' | 'busy'
  role?: 'status'
  children: ReactNode
}) {
  return (
    <p
      role={role}
      className={cn(
        'flex gap-1.5 px-1 text-small',
        tone === 'error' ? 'text-danger' : 'text-muted',
      )}
    >
      <span className="flex h-4 w-3.5 shrink-0 items-center justify-center">
        {tone === 'busy' ? (
          <Spinner />
        ) : tone === 'error' ? (
          <TriangleAlert className="size-3.5" aria-hidden="true" />
        ) : (
          <Info className="size-3.5" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 select-text break-words">{children}</span>
    </p>
  )
}

function AgentStatus({ meta }: { meta: ChatMeta }) {
  if (meta.status === 'starting') return <Line tone="busy">Starting {meta.agentName}…</Line>
  if (meta.status === 'error' && meta.error) {
    return (
      <div className="flex flex-col gap-1">
        <Line tone="error">
          {meta.error} <span className="text-muted">Send a message to retry.</span>
        </Line>
        {meta.errorDetail && <TechnicalDetails text={meta.errorDetail} className="pl-6" />}
      </div>
    )
  }
  return null
}
