import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'

export type Status = 'ready' | 'busy' | 'error' | 'idle'

/**
 * The one status indicator, 6px: green when ready or running, pulsing amber while busy
 * (starting, installing, working), red on an error, a hollow ring when idle. Pair it with
 * text or a tooltip; it's hidden from assistive tech.
 */
export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        status === 'ready' && 'bg-success',
        status === 'busy' && 'animate-pulse bg-warning',
        status === 'error' && 'bg-danger',
        status === 'idle' && 'border border-line-strong bg-fill',
        className,
      )}
    />
  )
}

const BADGE_TONE = {
  neutral: 'bg-fill text-muted',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const

interface BadgeProps {
  tone?: keyof typeof BADGE_TONE
  /** Monospace, for code-like names */
  mono?: boolean
  /** A 12px glyph before the text */
  icon?: LucideIcon
  title?: string
  className?: string
  children: ReactNode
}

/**
 * A small, non-interactive label for a state or a name: the agent's mode, the element a
 * message was about. Truncate long text inside it with a `truncate` span.
 */
export function Badge({
  tone = 'neutral',
  mono = false,
  icon: Icon,
  title,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 min-w-0 items-center gap-1 rounded-sm px-1.5 text-caption font-medium',
        BADGE_TONE[tone],
        mono && 'font-mono',
        className,
      )}
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden="true" />}
      {children}
    </span>
  )
}
