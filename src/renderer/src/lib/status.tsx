import type { ReactNode } from 'react'
import { cn } from './cn'
import type { IconComponent } from './icons'

export type Status = 'ready' | 'busy' | 'error' | 'idle' | 'attention'

/**
 * The one status indicator, 6px: green when ready or running, amber while busy (starting,
 * installing, working), a red square on an error so it doesn't rest on color alone, a ring
 * when idle, accent when something there wants the user (a finished turn in a hidden chat).
 * Pair it with text or a tooltip; it's hidden from assistive tech.
 */
export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none size-1.5 shrink-0 select-none',
        status === 'error' ? 'rounded-none' : 'rounded-full',
        status === 'ready' && 'bg-success',
        // Solid: a spinner beside it (tab, Working, bubble) already says it's moving.
        status === 'busy' && 'bg-warning',
        status === 'error' && 'bg-danger',
        status === 'idle' && 'border border-edge bg-fill',
        status === 'attention' && 'bg-accent',
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
  icon?: IconComponent
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
