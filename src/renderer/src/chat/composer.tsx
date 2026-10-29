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
  Info,
  MousePointer2,
  Paperclip,
  Reply,
  Square,
  TriangleAlert,
  X,
} from '../lib/icons'
import { Card, Thumbnail } from '../lib/surface'
import { Button, Counter, IconButton, Spinner } from '../lib/ui'
import { AgentSetup, shouldShowAgentSetup } from './agent-setup'
import { AutoToggle } from './auto-toggle'
import { useCommandMenu } from './command-menu'
import { ImageError, imageFiles, MAX_IMAGES, prepareImage } from './images'
import { ModelButton } from './model-picker'
import { QueuedMessages } from './queue'
import { RecordingClip } from './recording-clip'
import {
  addAttachments,
  dismissProblems,
  noteSend,
  removeAttachments,
  removeRecordings,
  setDraft,
  setFollowUp,
  setNotice,
  settleSend,
  useChat,
} from './store'
import { NOTE_INSET, pickLabel } from './turn-view'

const NOTICE_MS = 5000

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

export function Composer({ meta, running }: { meta: ChatMeta; running: boolean }) {
  // The draft lives in the store: docking, floating and minimizing remount this component.
  const text = useChat((s) => s.draft)
  const firstMessage = useChat((s) => s.turnIds.length === 0)
  const attachments = useChat((s) => s.attachments)
  const recordings = useChat((s) => s.recordings)
  // A turn that's gone (a new session) has nothing to follow up on.
  const followUp = useChat((s) => s.turnsById[s.followUp ?? ''] ?? null)
  const dismissed = useChat((s) => s.dismissedProblems)
  const unseenProblem = meta.problems.some((problem) => !dismissed.includes(problem.id))
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  /** Images still being downscaled; a ref so overlapping pastes count each other. */
  const processing = useRef(0)
  const [pending, setPending] = useState(0)
  const [dropping, setDropping] = useState(false)
  /** Why a file wasn't attached; quiet and short-lived. In the store, as main can set it too. */
  const notice = useChat((s) => s.notice)

  useEffect(() => gui.onChatFocus(() => input.current?.focus()), [])
  const previousRecordings = useRef(recordings.length)
  useEffect(() => {
    if (recordings.length > previousRecordings.current)
      input.current?.focus({ preventScroll: true })
    previousRecordings.current = recordings.length
  }, [recordings.length])
  // Asking to follow up on a turn means writing about it next.
  const followUpId = followUp?.id ?? null
  useEffect(() => {
    if (followUpId) input.current?.focus({ preventScroll: true })
  }, [followUpId])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // A narrated clip goes out with what was said, once it's transcribed (a second or two).
  const transcribing = recordings.some((clip) => clip.narration?.status === 'transcribing')
  const canSend =
    (text.trim() !== '' || attachments.length > 0 || recordings.length > 0) &&
    pending === 0 &&
    !transcribing
  /** Why Send is off, for its tooltip. */
  const cantSend =
    pending > 0
      ? 'Wait for images to finish attaching'
      : transcribing
        ? 'Wait for the narration to be transcribed'
        : 'Write a message first'

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
    const about = followUp?.id ?? null
    sending.current = true
    // Its turn (or queued message) rises out of the composer when main reports it.
    noteSend(
      text,
      sent.map((image) => image.id),
      clips,
      about,
    )
    try {
      // Keep the draft unless main took it (started the turn or queued it). Only what went
      // out clears: an image attached while sending stays for the next message.
      const accepted = await gui.send(text, images, clips, about)
      settleSend(
        accepted,
        text,
        sent.map((image) => image.id),
        clips,
        about,
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
      className="flex max-h-3/5 min-h-0 shrink-0 flex-col gap-2 overflow-y-auto border-t border-line p-2"
    >
      {/* Setting the agent up is the next step; it stands in for an error saying it isn't */}
      {shouldShowAgentSetup(meta) ? (
        <AgentSetup meta={meta} className={ARRIVE} />
      ) : (
        <AgentStatus meta={meta} />
      )}
      {unseenProblem && <ProblemsBar meta={meta} running={running} />}
      <QueuedMessages meta={meta} running={running} />
      {meta.selectionError && (
        <Line tone="error" role="alert">
          {meta.selectionError}
        </Line>
      )}
      {meta.selection.length > 0 && <Selection selection={meta.selection} />}
      {followUp && (
        <FollowUpCard
          number={followUp.index + 1}
          prompt={followUp.prompt}
          onRemove={() => {
            setFollowUp(null)
            input.current?.focus({ preventScroll: true })
          }}
        />
      )}
      {notice && (
        <Line tone="info" role="status">
          {notice}
        </Line>
      )}
      {commands.element}
      {/* The field's focus look on a frame of several controls, which takes a card's radius.
          Popovers from the controls in it open off its edge (data-popover-anchor), not over it. */}
      <div
        data-popover-anchor=""
        className={cn(
          'relative rounded-lg border border-edge bg-raised transition-colors focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
          dropping && 'border-accent bg-accent-soft',
        )}
      >
        {/* Says what a drop does, over the box, until the files land or leave. */}
        {dropping && (
          <p
            aria-hidden="true"
            // The accent tint over the box's own color, opaque so the draft doesn't show through.
            style={{
              background: 'linear-gradient(var(--accent-soft), var(--accent-soft)), var(--raised)',
            }}
            className="pointer-events-none absolute inset-0 z-sticky flex items-center gap-2 rounded-lg px-3 text-small font-medium text-accent-text"
          >
            <Paperclip className="size-3.5 shrink-0" aria-hidden="true" />
            Drop images to attach
          </p>
        )}
        {(attachments.length > 0 || pending > 0) && (
          <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-2 pt-2">
            {attachments.map((image) => (
              <li key={image.id} className={PLACE}>
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
          <fieldset
            aria-label="Attached recordings"
            className="flex max-h-36 flex-col gap-2 overflow-y-auto px-2 pt-2"
          >
            {recordings.map((clip) => (
              <RecordingClip
                key={clip.id}
                clip={clip}
                compact
                onPreviewClose={() => input.current?.focus({ preventScroll: true })}
                onRemove={() => {
                  removeRecordings([clip.id], true)
                  input.current?.focus({ preventScroll: true })
                }}
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
              : meta.selection.length > 0 || attachments.length > 0 || recordings.length > 0
                ? 'Describe the change…'
                : `Ask ${meta.agentName}…`
          }
          className="field-sizing-content block max-h-40 min-h-9 w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-fg outline-none focus-visible:outline-none placeholder:text-subtle"
        />
        {firstMessage && meta.autoApprove && (
          <p className="px-2.5 pb-2 text-caption text-muted">
            Auto is on: your agent can edit files and run commands without asking, including
            commands outside this project. Turn Auto off to review more requests.
          </p>
        )}
        {/* A container: in a narrow panel, Auto and the model button get more compact. */}
        <div className="@container flex items-center gap-1 px-1.5 pb-1.5">
          <IconButton
            label="Attach images"
            icon={Paperclip}
            disabled={attachments.length + pending >= MAX_IMAGES}
            title={
              attachments.length + pending >= MAX_IMAGES
                ? `Up to ${MAX_IMAGES} images per message`
                : undefined
            }
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
              shortcut="send"
              title={canSend ? undefined : cantSend}
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

/** What arrives above the message box (a notice, the problems, the picks) rises in as a transcript row does. */
const ARRIVE = 'motion-safe:animate-row-in motion-reduce:animate-row-fade'
/** An image placed among the attachments settles in from slightly smaller. */
const PLACE = 'motion-safe:animate-place-in motion-reduce:animate-row-fade'

function ProblemsBar({ meta, running }: { meta: ChatMeta; running: boolean }) {
  const latest = meta.problems.at(-1)
  return (
    // A compact card: a line (two, with the latest error), Fix, and an X that hides it until a new error.
    <Card tone="inset" padding="compact" className={cn(ARRIVE, 'flex items-center gap-2')}>
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
        title={running ? 'Wait for the agent to finish' : 'Ask the agent to fix these errors'}
        onClick={() => void gui.fixProblems()}
      >
        Fix
      </Button>
      <IconButton
        size="sm"
        label="Dismiss errors"
        title="Dismiss"
        icon={X}
        onClick={() => dismissProblems(meta.problems.map((problem) => problem.id))}
      />
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
    <Card tone="inset" padding="none" className={cn(ARRIVE, 'max-h-36 overflow-y-auto')}>
      <ul
        aria-label={several ? `${selection.length} selected` : 'Selected'}
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
                <Thumbnail src={picked.screenshot} size="sm" fit="element" />
              ) : (
                <Thumbnail size="sm">
                  {isRegion(picked) ? (
                    <Crop className="size-3.5" aria-hidden="true" />
                  ) : (
                    <MousePointer2 className="size-3.5" aria-hidden="true" />
                  )}
                </Thumbnail>
              )}
              {several && <Counter className="absolute -top-1 -left-1">{i + 1}</Counter>}
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

/** The earlier turn the next message follows up on, until it's sent or removed. */
function FollowUpCard({
  number,
  prompt,
  onRemove,
}: {
  number: number
  prompt: string
  onRemove: () => void
}) {
  return (
    <Card tone="inset" padding="compact" className={cn(ARRIVE, 'flex items-center gap-2')}>
      <Reply className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-small" title={prompt}>
        <span className="text-muted">Following up on </span>
        {prompt}
      </p>
      <IconButton
        size="sm"
        label={`Stop following up on message ${number}`}
        title="Remove"
        icon={X}
        onClick={onRemove}
      />
    </Card>
  )
}

function PickedLabel({ picked }: { picked: Picked }) {
  const { name, detail, where, title } = pickLabel(picked)
  return (
    <div className="min-w-0 flex-1" title={title}>
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
  /** status: read out politely as it changes; alert: an error, read out at once */
  role?: 'status' | 'alert'
  children: ReactNode
}) {
  return (
    <p
      role={role}
      className={cn(
        ARRIVE,
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
        <Line tone="error" role="alert">
          {meta.error} <span className="text-muted">Send a message to retry.</span>
        </Line>
        {/* Under the line's text, as under a note's in the transcript */}
        {meta.errorDetail && (
          <div className="px-1">
            <TechnicalDetails text={meta.errorDetail} className={NOTE_INSET} />
          </div>
        )}
      </div>
    )
  }
  return null
}
