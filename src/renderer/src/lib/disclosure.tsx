import { type ComponentProps, useState } from 'react'
import { cn } from './cn'
import { ChevronRight } from './icons'
import { PRESS } from './ui'

interface DisclosureProps extends Omit<ComponentProps<'button'>, 'onToggle'> {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** label: the size and color of a GroupLabel, for a collapsible group heading */
  tone?: 'default' | 'label'
}

/**
 * What a Disclosure shows, coming in as its chevron turns: a 4px rise and fade (a transcript
 * row's), or the fade alone with reduced motion. Closing is instant.
 */
export const REVEAL = 'motion-safe:animate-row-in motion-reduce:animate-row-fade'

/**
 * The one show/hide toggle: a chevron on the left that turns down when open, then the label.
 * Steps, changed files, technical details, the branch summary, collapsible groups. The
 * chevron hangs into the left margin so the label lines up with the text around it; only the
 * left, so it never widens a scrolling container. Put it in a wrapper to push it right.
 */
export function Disclosure({
  open,
  onOpenChange,
  tone = 'default',
  className,
  children,
  ...props
}: DisclosureProps) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
      className={cn(
        '-ml-1 flex h-6 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-left transition-[color,background-color,opacity] hover:bg-hover hover:text-fg',
        PRESS,
        tone === 'default' ? 'text-small text-muted' : 'text-caption font-medium text-subtle',
        className,
      )}
      {...props}
    >
      <ChevronRight
        className={cn(
          'size-3 shrink-0 transition-transform motion-reduce:transition-none',
          open && 'rotate-90',
        )}
        aria-hidden="true"
      />
      {children}
    </button>
  )
}

/** Technical detail (exit codes, output, commands) one click away from a plain message. */
export function TechnicalDetails({
  text,
  className,
  state,
}: {
  text: string
  className?: string
  /** A transcript can retain the disclosure while its virtual row is unmounted. */
  state?: readonly [boolean, (open: boolean) => void]
}) {
  const local = useState(false)
  const [open, setOpen] = state ?? local
  return (
    <div className={cn('flex flex-col items-start gap-1', className)}>
      <Disclosure open={open} onOpenChange={setOpen}>
        Details
      </Disclosure>
      {open && (
        <pre
          className={cn(
            REVEAL,
            'max-h-48 w-full select-text overflow-y-auto scroll-stable whitespace-pre-wrap break-words pl-4 text-left font-mono text-caption text-muted',
          )}
        >
          {text}
        </pre>
      )}
    </div>
  )
}
