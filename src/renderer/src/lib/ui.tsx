import type { LucideIcon } from 'lucide-react'
import { type ComponentProps, type ReactNode, useId } from 'react'
import {
  ariaShortcut,
  type ShortcutId,
  shortcutText,
  withShortcut,
} from '../../../shared/shortcuts'
import { cn } from './cn'

/*
 * Controls. Sizes: sm 24px for in-row actions (queue, turn footer, list rows), md 28px the
 * default, lg 32px only for the canvas's primary call to action. One look per state: hover
 * tints, pressed or selected is accent-soft with accent text, disabled fades to 40%, focus
 * is the global accent ring. Icons inside controls are 14px; chevrons and other trailing
 * glyphs 12px. A control with a keyboard shortcut takes its id (`shortcut`, from
 * src/shared/shortcuts.ts): its tooltip names the keys and `aria-keyshortcuts` gives them.
 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ControlSize = 'sm' | 'md' | 'lg'

const CONTROL =
  'no-drag inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-40'

const BUTTON_SIZE: Record<ControlSize, string> = {
  sm: 'h-6 gap-1 px-2 text-small',
  md: 'h-7 gap-1.5 px-2.5 text-small',
  lg: 'h-8 gap-1.5 px-3 text-body',
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-line-strong bg-raised text-fg hover:tint',
  ghost: 'text-muted hover:bg-hover hover:text-fg',
  danger: 'bg-danger-soft text-danger hover:tint',
}

interface ButtonProps extends ComponentProps<'button'> {
  /**
   * primary: the one thing to do next (at most one per view). secondary: the default, for
   * other actions and retries. ghost: quiet actions next to a primary or in headers.
   * danger: confirming something destructive.
   */
  variant?: ButtonVariant
  size?: ControlSize
  /** Leading icon, 14px */
  icon?: LucideIcon
  /** Trailing glyph, 12px: a menu's chevron, an external link */
  trailingIcon?: LucideIcon
  /** Working: a spinner replaces the icon and the button is disabled */
  loading?: boolean
  /** Its keyboard shortcut, shown as keys at the end */
  shortcut?: ShortcutId
}

/** A labelled action. Use IconButton when the action is an icon alone, Toggle for on/off. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  trailingIcon: Trailing,
  loading = false,
  shortcut,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-keyshortcuts={shortcut && ariaShortcut(shortcut)}
      className={cn(CONTROL, BUTTON_SIZE[size], VARIANT[variant], className)}
      {...props}
    >
      {loading ? <Spinner /> : Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {children}
      {shortcut && (
        // On a filled button the keys take its text color.
        <Kbd tone={variant === 'primary' || variant === 'danger' ? 'inherit' : 'muted'}>
          {shortcutText(shortcut)}
        </Kbd>
      )}
      {Trailing && <Trailing className="size-3 shrink-0" aria-hidden="true" />}
    </button>
  )
}

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  /** What it does, in words: the accessible name and the tooltip (required) */
  label: string
  /** Its keyboard shortcut, named in the tooltip */
  shortcut?: ShortcutId
  /** A tooltip other than the label, such as what it just did */
  title?: string
  icon: LucideIcon
  size?: 'sm' | 'md'
  /** ghost, the default; primary for Send; secondary for a bordered one like Stop */
  variant?: 'ghost' | 'primary' | 'secondary'
  /** Makes it a toggle: aria-pressed, and accent-soft with accent text while pressed */
  pressed?: boolean
  /** Turns the icon while something loads (Reload) */
  spinning?: boolean
  /** Fills the icon's shape (Stop's square) */
  filled?: boolean
}

/** An action shown as an icon alone. Toolbars, panel headers, remove buttons in rows. */
export function IconButton({
  label,
  shortcut,
  icon: Icon,
  size = 'md',
  variant = 'ghost',
  pressed,
  spinning = false,
  filled = false,
  title,
  className,
  ...props
}: IconButtonProps) {
  // A `title` of its own (what it just did) stands in for the label and keys for a moment.
  const tooltip = title ?? (shortcut ? withShortcut(label, shortcut) : label)
  return (
    <button
      type="button"
      aria-label={label}
      title={tooltip}
      aria-keyshortcuts={shortcut && ariaShortcut(shortcut)}
      aria-pressed={pressed}
      className={cn(
        CONTROL,
        'shrink-0',
        size === 'sm' ? 'size-6' : 'size-7',
        pressed ? 'bg-accent-soft text-accent-text' : VARIANT[variant],
        className,
      )}
      {...props}
    >
      <Icon
        className={cn('size-3.5', spinning && 'animate-spin', filled && 'fill-current')}
        aria-hidden="true"
      />
    </button>
  )
}

interface ToggleProps extends Omit<ComponentProps<'button'>, 'children'> {
  pressed: boolean
  icon?: LucideIcon
  children: ReactNode
  /**
   * soft (default): accent-soft while on, for a setting (Auto). strong: solid accent, for a
   * mode the whole window is in (Select).
   */
  emphasis?: 'soft' | 'strong'
  /** Its keyboard shortcut, named after the tooltip (`title`) */
  shortcut?: ShortcutId
}

/** A labelled on/off control (aria-pressed). Its weight never changes with its state. */
export function Toggle({
  pressed,
  icon: Icon,
  emphasis = 'soft',
  shortcut,
  title,
  className,
  children,
  ...props
}: ToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title && shortcut ? withShortcut(title, shortcut) : title}
      aria-keyshortcuts={shortcut && ariaShortcut(shortcut)}
      className={cn(
        CONTROL,
        BUTTON_SIZE.md,
        'shrink-0',
        !pressed && VARIANT.ghost,
        pressed && emphasis === 'soft' && 'bg-accent-soft text-accent-text',
        pressed && emphasis === 'strong' && VARIANT.primary,
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {children}
    </button>
  )
}

interface Segment<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  /** Tooltip, when it should say more than the label */
  title?: string
  /** Its keyboard shortcut, named in the tooltip */
  shortcut?: ShortcutId
}

interface SegmentedControlProps<T extends string> {
  segments: readonly Segment<T>[]
  value: T
  onChange: (value: T) => void
  /** Names the group (or use labelledBy) */
  label?: string
  labelledBy?: string
  /** Icons only; each label becomes the segment's name and tooltip */
  iconOnly?: boolean
  /** Segments share the width and truncate (effort levels) */
  stretch?: boolean
  className?: string
}

/**
 * One choice out of a few, side by side: the viewport, effort levels. A group of pressed
 * buttons on a filled track, 28px tall.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  labelledBy,
  iconOnly = false,
  stretch = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <fieldset
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn(
        'no-drag flex min-w-0 items-center gap-0.5 rounded-md bg-fill p-0.5',
        className,
      )}
    >
      {segments.map((segment) => {
        const on = segment.value === value
        const Icon = segment.icon
        const title = segment.title ?? (iconOnly ? segment.label : undefined)
        return (
          <button
            key={segment.value}
            type="button"
            aria-pressed={on}
            aria-label={iconOnly ? segment.label : undefined}
            title={title && segment.shortcut ? withShortcut(title, segment.shortcut) : title}
            aria-keyshortcuts={segment.shortcut && ariaShortcut(segment.shortcut)}
            onClick={() => onChange(segment.value)}
            className={cn(
              'flex h-6 items-center justify-center rounded-sm text-small font-medium transition-colors',
              iconOnly ? 'w-6' : stretch ? 'px-1.5' : 'px-2',
              stretch && 'min-w-0 flex-auto',
              on ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-hover hover:text-fg',
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
            {!iconOnly && <span className="truncate">{segment.label}</span>}
          </button>
        )
      })}
    </fieldset>
  )
}

/**
 * Something is in progress. sm (12px) inline next to text and inside buttons; md (16px)
 * for a centered loading state. Takes the current text color.
 */
export function Spinner({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0 animate-spin', size === 'sm' ? 'size-3' : 'size-4', className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Code inside running text: a command, a file name, a branch. A step smaller than its text. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('inline-code', className)}>{children}</code>
}

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Visible text beside the switch; part of its name */
  label: ReactNode
  /** Id of an element that names what this controls; read before the label */
  labelledBy?: string
  disabled?: boolean
  /** Text size and color for the label (the switch sets none of its own), and layout */
  className?: string
}

/** An on/off setting that applies at once (role="switch"): its label, then the track. */
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
          checked ? 'bg-accent' : 'bg-fill ring-1 ring-line-strong ring-inset',
        )}
      >
        <span
          className={cn(
            'size-3 rounded-full bg-knob shadow-raised transition-transform',
            checked && 'translate-x-3',
          )}
        />
      </span>
    </button>
  )
}

interface KbdProps {
  children: ReactNode
  /** muted (default) in running text; inherit takes the text's color, inside a filled button */
  tone?: 'muted' | 'inherit'
}

/** A key or shortcut named in running text, e.g. ⌘D. */
export function Kbd({ children, tone = 'muted' }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 font-sans text-caption font-medium',
        tone === 'muted' ? 'bg-fill text-muted' : 'bg-current/15 text-current',
      )}
    >
      {children}
    </kbd>
  )
}

/** A shortcut as keycaps, one per key: ⇧ ⌘ L. */
export function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <kbd className="inline-flex shrink-0 items-center gap-0.5">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </kbd>
  )
}
