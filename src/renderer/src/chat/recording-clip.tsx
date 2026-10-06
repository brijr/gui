import { useRef, useState } from 'react'
import type { RecordingAttachment } from '../../../shared/types'
import { Dialog } from '../lib/dialog'
import { Play, X } from '../lib/icons'
import { IconButton, PRESS } from '../lib/ui'

/** Said in place of the video when its file can't be played (moved, or deleted). */
function Unavailable() {
  return <p className="text-small text-muted">Recording is unavailable.</p>
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
      onPreviewClose?.()
    }
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface p-1">
        <button
          type="button"
          aria-label={`Play ${clip.name}`}
          onClick={() => setPreviewing(true)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-sm p-0.5 text-left transition-[background-color,opacity] hover:bg-hover ${PRESS}`}
        >
          <span className="relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-canvas">
            <img src={clip.thumbnail} alt="" className="size-full object-cover" />
            <span className="absolute flex size-5 items-center justify-center rounded-full bg-accent text-accent-fg">
              <Play className="size-3" aria-hidden="true" />
            </span>
          </span>
          <span className="min-w-0">
            <span className="block truncate text-small font-medium">{clip.name}</span>
            <span className="block text-caption text-subtle">
              <span className="tabular-nums">{duration}</span> · Click to play
            </span>
          </span>
        </button>
        {onRemove && <IconButton icon={X} label="Remove recording" onClick={onRemove} />}
        <Dialog
          open={previewing}
          onClose={close}
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
            // biome-ignore lint/a11y/useMediaCaption: Preview recordings contain no audio.
            <video
              ref={video}
              controls
              preload="none"
              poster={clip.thumbnail}
              src={clip.url}
              aria-label={clip.name}
              className="block w-full bg-canvas"
              onError={() => setFailed(true)}
            />
          )}
        </Dialog>
      </div>
    )
  }
  return (
    <div className="w-full max-w-80 overflow-hidden rounded-lg border border-line bg-surface">
      {failed ? (
        <div className="px-2 py-1.5">
          <Unavailable />
        </div>
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: Preview recordings contain no audio.
        <video
          controls
          preload="metadata"
          poster={clip.thumbnail}
          src={clip.url}
          aria-label={clip.name}
          className="block max-h-48 w-full"
          onError={() => setFailed(true)}
        />
      )}
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-caption text-muted">
        <span className="flex min-w-0 gap-1">
          <span className="truncate">{clip.name}</span>
          <span className="shrink-0 tabular-nums">· {duration}</span>
        </span>
        {onRemove && <IconButton icon={X} label="Remove recording" onClick={onRemove} />}
      </div>
    </div>
  )
}
