import { useRef } from 'react'
import { scrubSize } from '../../../shared/theme-tokens'
import { cn } from '../lib/cn'
import { type IconComponent, MoveHorizontal, SquareRoundCorner, TypeIcon } from '../lib/icons'

/** Pixels dragged per step, as in Figma's number fields. */
const PX_PER_STEP = 2

/** The handle's icon says what the size is for: a corner, text, or a distance. */
function iconFor(name: string): IconComponent {
  if (/radius|rounded/i.test(name)) return SquareRoundCorner
  if (/font|text|leading|line-height|letter/i.test(name)) return TypeIcon
  return MoveHorizontal
}

/**
 * Drag left or right on it to change a size, as in Figma: Shift for ten steps, Alt for a
 * tenth, Esc to go back to where the drag started. At most one change goes out per frame.
 */
export function ScrubHandle({
  name,
  value,
  onChange,
}: {
  name: string
  value: string
  onChange: (value: string) => void
}) {
  const Icon = iconFor(name)
  const drag = useRef<{ start: string; x: number; frame: number; next: string | null } | null>(null)
  const send = (next: string) => {
    const current = drag.current
    if (!current) return onChange(next)
    current.next = next
    if (current.frame) return
    current.frame = requestAnimationFrame(() => {
      const pending = drag.current
      if (!pending) return
      pending.frame = 0
      if (pending.next !== null) onChange(pending.next)
      pending.next = null
    })
  }
  // Esc goes back to the start; caught before the panel's own Esc, which would close it.
  const onKey = (event: KeyboardEvent) => {
    const current = drag.current
    if (event.key !== 'Escape' || !current) return
    event.preventDefault()
    event.stopImmediatePropagation()
    current.next = current.start
    end()
  }
  const end = () => {
    const current = drag.current
    drag.current = null
    window.removeEventListener('keydown', onKey, true)
    document.body.style.cursor = ''
    if (current?.frame) cancelAnimationFrame(current.frame)
    if (current?.next != null) onChange(current.next)
  }
  return (
    <span
      // Pointer only: the field beside it is the keyboard's way (↑/↓ nudge).
      aria-hidden
      title="Drag to change · Shift ×10 · Alt ×0.1"
      onPointerDown={(event) => {
        if (scrubSize(value, 0, false, false) === null) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { start: value, x: event.clientX, frame: 0, next: null }
        document.body.style.cursor = 'ew-resize'
        window.addEventListener('keydown', onKey, true)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        const steps = (event.clientX - current.x) / PX_PER_STEP
        const next = scrubSize(current.start, steps, event.shiftKey, event.altKey)
        if (next !== null) send(next)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      className={cn(
        'grid size-7 shrink-0 cursor-ew-resize touch-none select-none place-items-center rounded-md',
        'border border-edge bg-raised text-subtle hover:text-fg',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  )
}
