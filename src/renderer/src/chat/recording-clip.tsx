import { type Ref, useRef, useState } from 'react'
import type { RecordingAttachment } from '../../../shared/types'
import { Dialog } from '../lib/dialog'
import { Play, X } from '../lib/icons'
import { Card } from '../lib/surface'
import { IconButton, PRESS } from '../lib/ui'

/** Said in place of the video when its file can't be played (moved, or deleted). */
function Unavailable() {
  return <p className="text-small text-muted">Recording is unavailable.</p>
}

/** A narrated clip's transcript as it's being made, or what went wrong. */
function narrationNote(clip: RecordingAttachment) {
  const narration = clip.narration
  if (!narration) return null
  if (narration.status === 'transcribing') return 'Transcribing…'
  if (narration.status === 'failed') return narration.error ?? 'No transcript'
  return 'Narrated'
}

/** The player: with sound and captions when the user talked over it. */
function Player({
  clip,
  className,
  preload,
  onError,
  videoRef,
}: {
  clip: RecordingAttachment
  className: string
  preload: 'none' | 'metadata'
  onError: () => void
  videoRef?: Ref<HTMLVideoElement>
}) {
  const captions = clip.narration?.status === 'done' ? clip.narration.captions : undefined
  return (
    // biome-ignore lint/a11y/useMediaCaption: Silent clips have no audio; narrated ones carry captions.
    <video
      ref={videoRef}
      controls
      preload={preload}
      width={clip.width}
      height={clip.height}
      poster={clip.thumbnail}
      src={clip.url}
      // Its captions come from Gui's recording scheme, which a <track> loads with CORS.
      crossOrigin={captions ? 'anonymous' : undefined}
      aria-label={clip.name}
      className={className}
      onError={onError}
    >
      {captions && <track kind="captions" src={captions} srcLang="en" label="Narration" default />}
    </video>
  )
}

export function RecordingClip({
  clip,
  onRemove,
  compact = false,
  onPreviewClose,
}: {
  clip: RecordingAttachment
  onRemove?: () => void
  /** A row in the composer that opens the clip in a dialog, rather than the player inline */
  compact?: boolean
  /** After the dialog closes, so the composer can take focus back */
  onPreviewClose?: () => void
}) {
  const [failed, setFailed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const duration = `${(clip.durationMs / 1000).toFixed(1)}s`
  if (compact) {
    const close = () => {
      video.current?.pause()
      setPreviewing(false)
    }
    return (
      <Card tone="inset" padding="none" className="flex items-center gap-2 p-1">
        <button
          type="button"
          aria-label={`Play ${clip.name}`}
          title={`Play ${clip.name}`}
          onClick={() => setPreviewing(true)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-sm p-0.5 text-left transition-[background-color,opacity] hover:bg-hover ${PRESS}`}
        >
          <span className="relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-canvas">
            <img
              src={clip.thumbnail}
              alt=""
              className="size-full object-cover outline-1 -outline-offset-1 outline-line"
            />
            <span className="absolute flex size-5 items-center justify-center rounded-full bg-tile/70 text-tile-fg">
              <Play className="size-3" aria-hidden="true" />
            </span>
          </span>
          <span className="min-w-0">
            <span className="block truncate text-small font-medium">{clip.name}</span>
            <span className="block truncate text-caption text-subtle">
              <span className="tabular-nums">{duration}</span> ·{' '}
              {narrationNote(clip) ?? 'Click to play'}
            </span>
          </span>
        </button>
        {onRemove && (
          <IconButton size="sm" icon={X} label={`Remove ${clip.name}`} onClick={onRemove} />
        )}
        <Dialog
          open={previewing}
          onClose={close}
          // While the modal is open the composer is inert and can't take focus back.
          onClosed={onPreviewClose}
          size="lg"
          title={
            <>
              {clip.name} · <span className="tabular-nums">{duration}</span>
            </>
          }
          // The video runs edge to edge; the message, if it can't, at the body's insets.
          className={failed ? undefined : 'p-0'}
        >
          {failed ? (
            <Unavailable />
          ) : (
            <Player
              clip={clip}
              videoRef={video}
              preload="none"
              className="block w-full bg-canvas"
              onError={() => setFailed(true)}
            />
          )}
        </Dialog>
      </Card>
    )
  }
  return (
    <Card tone="inset" padding="none" className="w-full max-w-80 overflow-hidden">
      {failed ? (
        <div className="px-2 py-1.5">
          <Unavailable />
        </div>
      ) : (
        <Player
          clip={clip}
          preload="metadata"
          className="block max-h-48 w-full"
          onError={() => setFailed(true)}
        />
      )}
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-caption text-muted">
        <span className="flex min-w-0 gap-1">
          <span className="truncate">{clip.name}</span>
          <span className="shrink-0 tabular-nums">· {duration}</span>
          {clip.narration && <span className="truncate">· {narrationNote(clip)}</span>}
        </span>
        {onRemove && (
          <IconButton size="sm" icon={X} label={`Remove ${clip.name}`} onClick={onRemove} />
        )}
      </div>
    </Card>
  )
}
