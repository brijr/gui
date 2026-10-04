import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

/**
 * The one field style, for inputs, textareas and selects: raised, a strong hairline, and on
 * focus an accent border with a soft accent ring instead of the outline buttons get.
 */
const FIELD =
  'rounded-md border border-line-strong bg-raised px-2.5 text-fg outline-none transition-colors placeholder:text-subtle focus:border-accent focus:ring-3 focus:ring-accent-soft focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'

/** Body text, or for code-like values (commands, branches, addresses) monospace at small */
const text = (mono: boolean) => (mono ? 'font-mono text-small' : 'text-body')

interface FieldStyleProps {
  /** For code-like values: monospace at the small size */
  mono?: boolean
}

/** A single-line text field, 28px tall. */
export function Input({
  mono = false,
  className,
  ...props
}: ComponentProps<'input'> & FieldStyleProps) {
  return <input className={cn(FIELD, 'h-7 w-full', text(mono), className)} {...props} />
}

/** A multi-line text field. Grows with its text up to a max height when given one. */
export function Textarea({
  mono = false,
  className,
  ...props
}: ComponentProps<'textarea'> & FieldStyleProps) {
  return (
    <textarea
      className={cn(FIELD, 'w-full resize-none py-1.5', text(mono), className)}
      {...props}
    />
  )
}

/** A native select in the field style, as wide as its choices (or what the caller sets). */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(FIELD, 'h-7 text-body', className)} {...props} />
}

interface FieldProps {
  label: string
  /** The control's id */
  htmlFor: string
  /** A line of help under the control; the control should point at `${htmlFor}-hint` */
  hint?: string
  children: ReactNode
}

/** A labelled control with an optional hint: label above, hint below. */
export function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-small font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${htmlFor}-hint`} className="text-caption text-subtle">
          {hint}
        </p>
      )}
    </div>
  )
}
