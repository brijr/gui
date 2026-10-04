import { ChevronRight } from 'lucide-react'
import { type ComponentProps, useState } from 'react'
import { cn } from './cn'

interface DisclosureProps extends Omit<ComponentProps<'button'>, 'onToggle'> {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** label: the size and color of a GroupLabel, for a collapsible group heading */
  tone?: 'default' | 'label'
}

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
        '-ml-1 flex h-6 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-left transition-colors hover:bg-hover hover:text-fg',
        tone === 'default' ? 'text-small text-muted' : 'text-caption font-medium text-subtle',
        className,
      )}
      {...props}
    >
      <ChevronRight
        className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        aria-hidden="true"
      />
      {children}
    </button>
  )
}

/** Technical detail (exit codes, output, commands) one click away from a plain message. */
export function TechnicalDetails({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('flex flex-col items-start gap-1', className)}>
      <Disclosure open={open} onOpenChange={setOpen}>
        Details
      </Disclosure>
      {open && (
        <pre className="max-h-48 w-full select-text overflow-y-auto whitespace-pre-wrap break-words pl-4 text-left font-mono text-caption text-muted">
          {text}
        </pre>
      )}
    </div>
  )
}
