import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'

/**
 * The one field style, for inputs, textareas and selects: raised, a strong hairline, and on
 * focus an accent border with a soft accent ring instead of the outline buttons get.
 */
const FRAME = 'rounded-md border border-line-strong bg-raised text-fg transition-colors'
const FIELD = `${FRAME} px-2.5 outline-none placeholder:text-subtle focus:border-accent focus:ring-3 focus:ring-accent-soft focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40`
/** The same frame around an input and a control at its start; it takes the focus look from the input. */
const GROUP = `${FRAME} flex items-center has-[input:focus]:border-accent has-[input:focus]:ring-3 has-[input:focus]:ring-accent-soft`

/** Body text, or for code-like values (commands, branches, addresses) monospace at small */
const text = (mono: boolean) => (mono ? 'font-mono text-small' : 'text-body')

interface FieldStyleProps {
  /** For code-like values: monospace at the small size */
  mono?: boolean
}

interface InputProps extends ComponentProps<'input'>, FieldStyleProps {
  /**
   * A small control inside the field, before the text: the address bar's dev-server status.
   * It sits flush with the field's left edge; give it its own padding.
   */
  leading?: ReactNode
  /** The same after the text, flush with the right edge: the address bar's zoom */
  trailing?: ReactNode
}

/** A single-line text field, 28px tall. */
export function Input({ mono = false, leading, trailing, className, ...props }: InputProps) {
  if (!leading && !trailing) {
    return <input className={cn(FIELD, 'h-7 w-full', text(mono), className)} {...props} />
  }
  return (
    <div className={cn(GROUP, 'h-7 w-full', className)}>
      {leading}
      <input
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle',
          !leading && 'pl-2.5',
          !trailing && 'pr-2.5',
          text(mono),
        )}
        {...props}
      />
      {trailing}
    </div>
  )
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
