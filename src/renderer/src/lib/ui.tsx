import { ChevronRight } from 'lucide-react'
import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react'
import { cn } from './cn'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  children: ReactNode
}

export function IconButton({ label, active, className, children, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors',
        'hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35',
        active && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
}

export function Button({ variant = 'secondary', className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border border-line-strong bg-raised text-fg hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-fg',
        className,
      )}
      {...props}
    />
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent',
        className,
      )}
    />
  )
}

/** Technical detail (exit codes, output, commands) one click away. */
export function TechnicalDetails({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 self-start rounded text-[11px] text-subtle hover:text-muted"
      >
        <ChevronRight
          className={cn('size-3 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        Details
      </button>
      {open && (
        <pre className="max-h-48 select-text overflow-y-auto whitespace-pre-wrap break-words pl-4 font-mono text-[11px] text-muted">
          {text}
        </pre>
      )}
    </div>
  )
}
