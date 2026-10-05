import { useState } from 'react'
import type { RecordingAttachment } from '../../../shared/types'
import { X } from '../lib/icons'
import { IconButton } from '../lib/ui'

export function RecordingClip({
  clip,
  onRemove,
}: {
  clip: RecordingAttachment
  onRemove?: () => void
}) {
  const [failed, setFailed] = useState(false)
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
          {clip.name} · {(clip.durationMs / 1000).toFixed(1)}s
        </span>
        {onRemove && <IconButton icon={X} label="Remove recording" onClick={onRemove} />}
      </div>
    </div>
  )
}
