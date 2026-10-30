import { type ComponentProps, type ReactNode, useId } from 'react'
import {
  ariaShortcut,
  type ShortcutId,
  shortcutText,
  withShortcut,
} from '../../../shared/shortcuts'
import { cn } from './cn'
import type { IconComponent } from './icons'

/*
 * Controls. Sizes: sm 24px for in-row actions (queue, turn footer, list rows), md 28px the
 * default, lg 32px only for the canvas's primary call to action. One look per state: hover
 * tints, pressed (a toggle that's on) is a neutral fill with the full text color (ON), solid
 * accent is only ever the one primary action in view, while it can be taken, disabled fades to
 * 40% (a primary goes neutral), focus is the global neutral ring. Icon-only controls rest in
 * the quietest text color, so a row of them recedes until pointed at. aria-disabled (still focusable, its tooltip saying why) looks and
 * acts as disabled does: no hover, no press. Held down, a control dims at once (PRESS) and eases back when
 * let go. Icons inside controls are 14px; chevrons and other trailing glyphs 12px. A control
 * with a keyboard shortcut takes its id (`shortcut`, from src/shared/shortcuts.ts): its
 * tooltip names the keys and `aria-keyshortcuts` gives them. Only a labelled Button shows them
 * as keys too, and only where they're needed to get out (Exit focus mode).
 */

/**
 * Press feedback: dims the moment it's pressed, with no transition in, and eases back over
 * the press duration when released (the transition that applies is the one in effect after
 * the change). Pair with a transition that includes opacity.
 */
export const PRESS = 'active:not-aria-disabled:opacity-70 active:transition-none'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ControlSize = 'sm' | 'md' | 'lg'

const CONTROL = `no-drag inline-flex items-center whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,opacity] ${PRESS}`

/** Disabled, a control fades; a primary one goes neutral instead (VARIANT), as a pale accent still reads as live. */
const FADE = 'disabled:opacity-40 aria-disabled:opacity-40'

/**
 * On: a toggle that's pressed, a button whose menu or picker is open. A neutral fill and the
 * full text color, darker again on hover; the one on-style for every control.
 */
export const ON = `bg-fill text-fg enabled:not-aria-disabled:hover:tint ${FADE}`
/** The same look on a button while the menu or picker it opens is open (aria-expanded). */
export const OPEN = 'aria-expanded:bg-fill aria-expanded:text-fg'

/**
 * A hit area 4px taller than the control and 2px wider each side, drawn by nothing: for 28px
 * controls in a bar, set at least 4px apart so neighbours' areas never meet. Out of the
 * window's drag region with the control.
 */
export const HIT_AREA =
  'relative before:absolute before:-inset-x-0.5 before:-inset-y-1 before:no-drag'

const BUTTON_SIZE: Record<ControlSize, string> = {
  sm: 'h-6 gap-1 px-2 text-small',
  md: 'h-7 gap-1.5 px-2.5 text-small',
  lg: 'h-8 gap-1.5 px-3 text-body',
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg enabled:not-aria-disabled:hover:bg-accent-hover disabled:bg-fill disabled:text-subtle aria-disabled:bg-fill aria-disabled:text-subtle',
  secondary: `border border-line-strong bg-raised text-fg shadow-control enabled:not-aria-disabled:hover:tint ${FADE}`,
  ghost: `text-muted enabled:not-aria-disabled:hover:bg-hover enabled:not-aria-disabled:hover:text-fg ${FADE}`,
  danger: `bg-danger-soft text-danger enabled:not-aria-disabled:hover:tint ${FADE}`,
}

/** Ghost, for an icon alone: the quietest text color at rest. */
const ICON_GHOST = `text-subtle enabled:not-aria-disabled:hover:bg-hover enabled:not-aria-disabled:hover:text-fg ${FADE}`

interface ButtonProps extends ComponentProps<'button'> {
  /**
   * primary: the one thing to do next (at most one per view). secondary: the default, for
   * other actions and retries. ghost: quiet actions next to a primary or in headers.
   * danger: confirming something destructive, or stopping something running (Record while
   * it records).
   */
  variant?: ButtonVariant
  size?: ControlSize
  /** Leading icon, 14px */
  icon?: IconComponent
  /** Trailing glyph, 12px: a menu's chevron, an external link */
  trailingIcon?: IconComponent
  /** Working: a spinner replaces the icon and the button is disabled */
  loading?: boolean
  /** Its keyboard shortcut, named in the tooltip */
  shortcut?: ShortcutId
  /** Shows the shortcut as keys at the end too: only where it's the way out (Exit focus mode) */
  keys?: boolean
}

/** A labelled action. Use IconButton when the action is an icon alone, Toggle for on/off. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  trailingIcon: Trailing,
  loading = false,
  shortcut,
  keys = false,
  disabled,
  title,
  className,
  children,
  ...props
}: ButtonProps) {
  // Shortcut-only controls still need a tooltip naming the action. Native titles can
  // appear over the preview's WebContentsView, where an HTML tooltip would be covered.
  const iconOnly = Icon && (children === undefined || children === null || children === false)
  // With a shortcut, a labelled button's tooltip is its label and keys.
  const tooltip =
    title ??
    (iconOnly || shortcut
      ? (props['aria-label'] ?? (typeof children === 'string' ? children : undefined))
      : undefined)
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={tooltip && shortcut ? withShortcut(tooltip, shortcut) : tooltip}
      aria-keyshortcuts={shortcut && ariaShortcut(shortcut)}
      // A label starts at the left, even in a button wider than it (text in Gui is never centered).
      className={cn(CONTROL, 'justify-start', BUTTON_SIZE[size], VARIANT[variant], className)}
      {...props}
    >
      {loading ? <Spinner /> : Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {children}
      {shortcut && keys && (
        // On a filled button the keys take its text color. Out of the button's name:
        // aria-keyshortcuts says them.
        <Kbd
          aria-hidden="true"
          tone={variant === 'primary' || variant === 'danger' ? 'inherit' : 'muted'}
        >
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
  icon: IconComponent
  size?: 'sm' | 'md'
  /** ghost, the default; primary for Send; secondary for a bordered one like Stop */
  variant?: 'ghost' | 'primary' | 'secondary'
  /** Makes it a toggle: aria-pressed, and the neutral ON fill while pressed */
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
        'shrink-0 justify-center',
        size === 'sm' ? 'size-6' : 'size-7',
        pressed ? ON : variant === 'ghost' ? ICON_GHOST : VARIANT[variant],
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
  icon?: IconComponent
  children: ReactNode
  /** Its keyboard shortcut, named after the tooltip (`title`) */
  shortcut?: ShortcutId
  /** md, the default; sm in a row of sm buttons (a turn's Follow up) */
  size?: 'sm' | 'md'
}

/** A labelled on/off control (aria-pressed). Its weight never changes with its state. */
export function Toggle({
  pressed,
  icon: Icon,
  shortcut,
  size = 'md',
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
        BUTTON_SIZE[size],
        'shrink-0 justify-start',
        pressed ? ON : VARIANT.ghost,
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
  icon?: IconComponent
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
  /** Shown but not choosable, e.g. while what it sets is switched off */
  disabled?: boolean
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
  disabled = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <fieldset
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className={cn(
        'no-drag flex min-w-0 items-center gap-0.5 rounded-md bg-fill p-0.5 disabled:opacity-40',
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
              'flex h-6 items-center justify-center rounded-sm text-small font-medium transition-[color,background-color,opacity]',
              PRESS,
              iconOnly ? 'w-6' : stretch ? 'px-1.5' : 'px-2',
              stretch && 'min-w-0 flex-auto',
              on
                ? 'bg-accent-soft text-accent-text'
                : 'text-muted enabled:hover:bg-hover enabled:hover:text-fg',
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
      className={cn(
        'pointer-events-none shrink-0 animate-spin select-none',
        size === 'sm' ? 'size-3' : 'size-4',
        className,
      )}
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
  /** The label is for screen readers only, where the row already says what the switch is */
  labelHidden?: boolean
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
  labelHidden = false,
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
      title={labelHidden && typeof label === 'string' ? label : undefined}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'no-drag flex h-7 shrink-0 items-center gap-2 rounded-md transition-[color,opacity]',
        PRESS,
        'disabled:opacity-40',
        className,
      )}
    >
      <span id={labelId} className={labelHidden ? 'sr-only' : undefined}>
        {label}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors',
          checked ? 'bg-accent' : 'bg-edge',
        )}
      >
        <span
          className={cn(
            'size-3 rounded-full bg-knob shadow-raised transition-transform motion-reduce:transition-none',
            checked && 'translate-x-3',
          )}
        />
      </span>
    </button>
  )
}

interface KbdProps extends ComponentProps<'kbd'> {
  /** muted (default) in running text; inherit takes the text's color, inside a filled button */
  tone?: 'muted' | 'inherit'
}

/** A key or shortcut named in running text, e.g. ⌘D. */
export function Kbd({ children, tone = 'muted', className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 font-sans text-caption font-medium',
        tone === 'muted' ? 'bg-fill text-muted' : 'bg-current/15 text-current',
        className,
      )}
      {...props}
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

interface TextButtonProps extends ComponentProps<'button'> {
  /** accent (default): an action in running text. muted: a quieter one beside a label. */
  tone?: 'accent' | 'muted'
}

/**
 * An action that reads as text: "Check now" beside a status, a link-like step inside a
 * sentence. It takes the size of the text around it; hover underlines it.
 */
export function TextButton({ tone = 'accent', className, ...props }: TextButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'no-drag inline-flex items-center gap-1 rounded-sm underline-offset-2 transition-[color,opacity] hover:underline disabled:pointer-events-none disabled:opacity-40',
        PRESS,
        tone === 'accent' ? 'text-accent-text' : 'text-muted hover:text-fg',
        className,
      )}
      {...props}
    />
  )
}

interface PromptButtonProps extends Omit<ComponentProps<'button'>, 'className'> {
  /** Sending: a spinner before the text, and it's disabled */
  loading?: boolean
}

/**
 * A suggested prompt in a list of ideas to start with: a small secondary button whose text
 * wraps over as many lines as it needs, rather than truncating.
 */
export function PromptButton({ loading = false, disabled, children, ...props }: PromptButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'no-drag inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-left text-small font-medium transition-[color,background-color,border-color,opacity]',
        PRESS,
        VARIANT.secondary,
      )}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
}

interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'children'> {
  /** Visible text after the box; part of its name */
  label: ReactNode
  /** Text size and color for the label, and layout */
  className?: string
}

/**
 * A choice that's saved with a form rather than applied at once (use Switch for that). 14px,
 * accent when checked, with its label after it.
 */
export function Checkbox({ label, className, disabled, ...props }: CheckboxProps) {
  return (
    <label
      className={cn(
        'flex min-h-7 items-center gap-2',
        disabled && 'pointer-events-none opacity-40',
        className,
      )}
    >
      <span className="relative flex size-3.5 shrink-0">
        <input
          type="checkbox"
          disabled={disabled}
          className="peer size-3.5 appearance-none rounded-sm border border-edge bg-raised shadow-control transition-colors checked:border-accent checked:bg-accent focus-visible:outline-offset-1"
          {...props}
        />
        <svg
          viewBox="0 0 14 14"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-3.5 text-accent-fg opacity-0 peer-checked:opacity-100"
        >
          <path
            d="M3.5 7.25 6 9.5l4.5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="min-w-0">{label}</span>
    </label>
  )
}

interface ProgressProps {
  /** 0 to 1; leave it out while there's no telling how far along it is */
  value?: number
  /** What's progressing, for assistive tech */
  label: string
  className?: string
}

/** How far along something is: a 4px accent bar on a fill track. */
export function Progress({ value, label, className }: ProgressProps) {
  const known = value !== undefined
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={known ? Math.round(value * 100) : undefined}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-fill', className)}
    >
      <div
        className={cn(
          'h-full rounded-full bg-accent transition-[width] duration-(--motion-panel) motion-reduce:transition-none',
          // Unknown: a third of the bar sweeps across; with reduced motion it sits still.
          !known && 'w-1/3 animate-sweep motion-reduce:animate-none',
        )}
        style={known ? { width: `${Math.max(0, Math.min(1, value)) * 100}%` } : undefined}
      />
    </div>
  )
}

/**
 * Where content is on its way: a pulsing fill at the size of what it stands in for. Give it
 * the width and height (h-4 for a line of text, h-9 for a row).
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block animate-pulse rounded-md bg-fill motion-reduce:animate-none', className)}
    />
  )
}

/**
 * A count or an order on the corner of something: the number of a picked element. 16px, accent.
 */
export function Counter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-caption font-medium text-accent-fg tabular-nums',
        className,
      )}
    >
      {children}
    </span>
  )
}
