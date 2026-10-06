import { useRef, useState } from 'react'
import type { RecordingAttachment } from '../../../shared/types'
import { Play, X } from '../lib/icons'
import { IconButton } from '../lib/ui'

export function RecordingClip({
  clip,
  onRemove,
  compact = false,
  onPreviewClose,
}: {
  clip: RecordingAttachment
  onRemove?: () => void
  compact?: boolean
  onPreviewClose?: () => void
}) {
  const [failed, setFailed] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const duration = `${(clip.durationMs / 1000).toFixed(1)}s`
  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface p-1.5">
        <button
          type="button"
          aria-label={`Play ${clip.name}`}
          onClick={() => dialog.current?.showModal()}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left hover:text-accent"
        >
          <span className="relative flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-canvas">
            <img src={clip.thumbnail} alt="" className="size-full object-cover" />
            <span className="absolute flex size-5 items-center justify-center rounded-full bg-scrim text-white">
              <Play className="size-3" aria-hidden="true" />
            </span>
          </span>
          <span className="min-w-0">
            <span className="block truncate text-small font-medium">{clip.name}</span>
            <span className="block text-caption text-subtle">{duration} · Click to play</span>
          </span>
        </button>
        {onRemove && <IconButton icon={X} label="Remove recording" onClick={onRemove} />}
        <dialog
          ref={dialog}
          aria-label={clip.name}
          className="no-drag m-auto w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-raised p-0 text-fg shadow-popover backdrop:bg-scrim"
          onClose={() => {
            video.current?.pause()
            onPreviewClose?.()
          }}
        >
          <div className="flex items-center justify-between gap-2 p-3">
            <span className="text-small font-medium">
              {clip.name} · {duration}
            </span>
            <IconButton
              icon={X}
              label="Close recording preview"
              onClick={() => dialog.current?.close()}
            />
          </div>
          {failed ? (
            <p className="p-3 text-small text-muted">Recording is unavailable.</p>
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: Preview recordings contain no audio.
            <video
              ref={video}
              controls
              preload="none"
              poster={clip.thumbnail}
              src={clip.url}
              aria-label={clip.name}
              className="block max-h-[70dvh] w-full bg-black"
              onError={() => setFailed(true)}
            />
          )}
        </dialog>
      </div>
    )
  }
  return (
    <div className="w-full max-w-80 overflow-hidden rounded-lg border border-line bg-surface">
      {failed ? (
        <p className="p-2 text-xs text-muted">Recording is unavailable.</p>
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
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted">
        <span>
          {clip.name} · {duration}
        </span>
        {onRemove && <IconButton icon={X} label="Remove recording" onClick={onRemove} />}
      </div>
    </div>
  )
}
