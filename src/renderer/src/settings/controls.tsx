import { type ReactNode, useId } from 'react'
import { cn } from '../lib/cn'

/** A titled group inside a settings section. */
export function GroupHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="font-medium text-[11px] text-subtle uppercase tracking-wide">
      {children}
    </h2>
  )
}

/** The rounded, divided list every settings group uses. */
export function List({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line rounded-lg border border-line">{children}</ul>
}

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Visible text beside the toggle */
  label: ReactNode
  /** Id of an element that names what this controls; read before the label */
  labelledBy?: string
  disabled?: boolean
  /** Text size and color for the label (the switch sets none of its own) */
  className?: string
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  labelledBy,
  disabled,
  className,
}: SwitchProps) {
  const labelId = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy ? `${labelledBy} ${labelId}` : labelId}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'no-drag flex h-7 shrink-0 items-center gap-2 rounded-md transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
    >
      <span id={labelId}>{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          className={cn(
            'size-3 rounded-full transition-transform',
            checked ? 'translate-x-3 bg-accent-fg' : 'bg-subtle',
          )}
        />
      </span>
    </button>
  )
}
