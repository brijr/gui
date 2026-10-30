import { type ComponentProps, type CSSProperties, type ReactNode, useEffect, useState } from 'react'
import { cn } from './cn'
import { Check, type IconComponent, Search, X } from './icons'
import { PRESS, Spinner } from './ui'

/*
 * Surfaces and layouts: containers, lists and the centered message. Panels and sheets are
 * radius-xl; cards, popovers, menus and thumbnails radius-lg; rows and controls radius-md.
 */

const CARD_PADDING = {
  card: 'p-3',
  compact: 'py-2 pr-2 pl-3',
  canvas: 'p-5',
  none: '',
} as const

interface CardProps extends ComponentProps<'div'> {
  /**
   * raised (default): a card on the canvas, white with a subtle shadow (setup, agent).
   * inset: a card inside a panel, on the surface color (permission, plan, queue, problems).
   */
  tone?: 'raised' | 'inset'
  /**
   * The card recipe (styles.css). card (default): 12px. compact: one or two lines and a small
   * button (problems, follow-up, plan). canvas: 20px, a card alone in the middle of the
   * canvas (setup, start your canvas). none: content that runs to the edges (a list, media).
   */
  padding?: keyof typeof CARD_PADDING
  as?: 'div' | 'section'
}

/** A bordered container, padded by the card recipe. */
export function Card({
  tone = 'raised',
  padding = 'card',
  as: Tag = 'div',
  className,
  ...props
}: CardProps) {
  return (
    <Tag
      className={cn(
        'rounded-lg border border-line',
        tone === 'raised' ? 'bg-raised shadow-raised' : 'bg-surface',
        CARD_PADDING[padding],
        className,
      )}
      {...props}
    />
  )
}

/** Where a popover goes, in the view's CSS pixels (placePopover). */
export interface PopoverPlacement {
  left: number
  width: number
  maxHeight: number
  /** From the view's bottom edge when it opens above the button, else null */
  bottom: number | null
  /** From the view's top edge when it opens below the button, else null */
  top: number | null
  /** Where it grows from: the middle of the button's edge it opens from, in its own box */
  origin: string
}

/** Room kept between a popover and the panel's edges. */
const POPOVER_EDGE = 8
/** Between a popover and its button. */
const POPOVER_GAP = 4
const POPOVER_WIDTH = 336
/** In a tall panel a popover stops growing here and scrolls. */
const POPOVER_MAX_HEIGHT = 440

/**
 * Places a popover against `button`'s right edge, above it unless there's more room below.
 * The chat is its own view and can't draw outside it, so the popover stays inside the panel
 * ([data-chat-panel]) and takes the height there is. Inside a [data-popover-anchor] frame (the
 * composer) it opens off the frame rather than the button, so it doesn't cover the frame's edge,
 * and spans it as the composer's command menu does: it covers what's above edge to edge rather
 * than leaving a sliver of it showing beside it.
 */
export function placePopover(button: HTMLElement): PopoverPlacement {
  const panel = (button.closest('[data-chat-panel]') ?? document.body).getBoundingClientRect()
  const box = button.getBoundingClientRect()
  const anchor = button.closest('[data-popover-anchor]')?.getBoundingClientRect()
  // Above or below the frame; it grows from the button.
  const edge = anchor ?? box
  const width = anchor ? anchor.width : Math.min(POPOVER_WIDTH, panel.width - POPOVER_EDGE * 2)
  const left = anchor
    ? anchor.left
    : Math.max(
        panel.left + POPOVER_EDGE,
        Math.min(box.right - width, panel.right - POPOVER_EDGE - width),
      )
  const above = edge.top - POPOVER_GAP - panel.top - POPOVER_EDGE
  const below = panel.bottom - POPOVER_EDGE - edge.bottom - POPOVER_GAP
  const x = Math.round(Math.min(Math.max(box.left + box.width / 2 - left, 0), width))
  return above >= below
    ? {
        left,
        width,
        maxHeight: Math.min(POPOVER_MAX_HEIGHT, above),
        bottom: window.innerHeight - edge.top + POPOVER_GAP,
        top: null,
        origin: `${x}px 100%`,
      }
    : {
        left,
        width,
        maxHeight: Math.min(POPOVER_MAX_HEIGHT, below),
        bottom: null,
        top: edge.bottom + POPOVER_GAP,
        origin: `${x}px 0`,
      }
}

interface PopoverProps extends ComponentProps<'div'> {
  /**
   * False while it closes: it goes back the way it came, quickly, and takes no input. Keep it
   * mounted for --motion-exit (usePresence) so the close can play.
   */
  open?: boolean
  /**
   * Floats it on the popover layer where placePopover put it, growing from its button. Without
   * one it sits in the flow (the composer's command menu): give it a `transformOrigin`.
   */
  placement?: PopoverPlacement
}

/**
 * The floating surface for menus and pickers. It opens out of what opened it, growing from
 * 97% at the trigger's edge and fading in quickly; it closes back into
 * it. With reduced motion it only fades.
 */
export function Popover({ open = true, placement, style, className, ...props }: PopoverProps) {
  return (
    <div
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      style={
        placement
          ? {
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              top: placement.top ?? undefined,
              bottom: placement.bottom ?? undefined,
              transformOrigin: placement.origin,
              ...style,
            }
          : style
      }
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-line bg-raised text-fg shadow-popover',
        placement && 'fixed z-popover',
        'transition-[opacity,scale] duration-(--motion-pop) ease-out starting:opacity-0 motion-safe:starting:scale-97',
        'data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 data-[state=closed]:duration-(--motion-exit) data-[state=closed]:ease-in motion-safe:data-[state=closed]:scale-97',
        'motion-reduce:duration-(--motion-fade) motion-reduce:ease-linear',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A popover's search or filter field, unframed across its top edge: a search glyph, then the
 * text. The caret shows focus and the placeholder a field's color. Give it an aria-label.
 */
export function PopoverSearch(props: Omit<ComponentProps<'input'>, 'className' | 'type'>) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5">
      <Search className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="h-9 min-w-0 flex-1 bg-transparent text-fg outline-none focus-visible:outline-none placeholder:text-subtle"
        {...props}
      />
    </div>
  )
}

/**
 * A line in a popover in place of its rows: loading, nothing yet, nothing matches. A MenuRow's
 * height inside the list's inset, with its text where theirs starts, so rows can take its place
 * without a jump.
 */
export function PopoverNote({
  loading = false,
  children,
}: {
  loading?: boolean
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <p role="status" className="flex h-9 shrink-0 items-center gap-2 px-3 text-small text-muted">
      {mounted && (
        <>
          {loading && <Spinner />}
          {children}
        </>
      )}
    </p>
  )
}

interface MenuRowProps extends ComponentProps<'div'> {
  /** Under the keyboard or pointer. Leave it out on a button row: the pointer highlights it. */
  highlighted?: boolean
  /** The current choice: a check at the end */
  selected: boolean
  /**
   * div (default): an option in a listbox, which keeps the focus and points at it. button: a
   * choice that applies and leaves the popover open (the picker's effort levels).
   */
  as?: 'div' | 'button'
}

/**
 * An option in a popover menu or listbox, 28px tall. Give it role="option" and its handlers.
 * Highlighted (under the pointer or the arrow keys) uses the accent tint, with
 * everything in it (icons, secondary text) in accent-text. Selected (the current choice) is
 * accent text and a check; highlighted too, it keeps the check.
 */
export function MenuRow({
  highlighted,
  selected,
  as = 'div',
  className,
  children,
  ...props
}: MenuRowProps) {
  const Tag = as as 'div'
  return (
    <Tag
      {...(as === 'button' && { type: 'button' })}
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-left text-small transition-opacity',
        PRESS,
        selected && 'text-accent-text',
        highlighted === undefined
          ? 'hover:bg-accent-soft hover:text-accent-text hover:**:text-accent-text'
          : highlighted && 'bg-accent-soft text-accent-text **:text-accent-text',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check className="size-3 shrink-0" aria-hidden="true" />}
    </Tag>
  )
}

export interface GroupLabelProps {
  children: ReactNode
  id?: string
  tabIndex?: number
  as?: 'h2' | 'h3' | 'p' | 'div' | 'span' | 'figcaption'
  className?: string
}

/** Names a group of rows or controls: caption, medium, subtle, sentence case. */
export function GroupLabel({ children, id, tabIndex, as: Tag = 'p', className }: GroupLabelProps) {
  return (
    <Tag
      id={id}
      tabIndex={tabIndex}
      className={cn('text-caption font-medium text-subtle', className)}
    >
      {children}
    </Tag>
  )
}

interface SectionHeaderProps {
  /** The GroupLabel's text */
  children: ReactNode
  id?: string
  as?: GroupLabelProps['as']
  /** A small action at the end: a ghost sm Button, a TextButton */
  action?: ReactNode
  className?: string
}

/** A GroupLabel with an action at the end of its line: "Agents ... Settings". */
export function SectionHeader({ children, id, as = 'h2', action, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex min-h-6 items-center justify-between gap-2', className)}>
      <GroupLabel id={id} as={as}>
        {children}
      </GroupLabel>
      {action && <div className="-my-1 flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  )
}

interface PanelHeaderProps extends Omit<ComponentProps<'header'>, 'title'> {
  /** The panel's name; body size, semibold, left-aligned and truncated. Or your own node. */
  title?: ReactNode
  titleId?: string
  /** Before the title: a status dot, a back button */
  leading?: ReactNode
  /** IconButtons (sm) and other actions at the end */
  actions?: ReactNode
  /** Leaves out the hairline under it, for a header over content of the same color */
  borderless?: boolean
}

/**
 * The one header for panels, sheets and dialogs: 36px, title at the start, actions at the end
 * (header recipe in styles.css). Children go between the two, for a header that needs more.
 */
export function PanelHeader({
  title,
  titleId,
  leading,
  actions,
  borderless = false,
  className,
  children,
  ...props
}: PanelHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-9 shrink-0 items-center gap-1.5 pr-1.5 pl-3',
        !borderless && 'border-b border-line',
        className,
      )}
      {...props}
    >
      {leading}
      {title !== undefined &&
        (typeof title === 'string' ? (
          <h2 id={titleId} title={title} className="min-w-0 flex-1 truncate font-semibold">
            {title}
          </h2>
        ) : (
          <div id={titleId} className="flex min-w-0 flex-1 items-center">
            {title}
          </div>
        ))}
      {children}
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </header>
  )
}

const BANNER_TONE = {
  neutral: 'bg-surface text-muted',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const

interface BannerProps {
  /** A 14px icon at the start */
  icon?: IconComponent
  tone?: keyof typeof BANNER_TONE
  /** Buttons at the end (sm) */
  actions?: ReactNode
  /** top: a hairline under it, for a bar above content; bottom: over it */
  edge?: 'top' | 'bottom'
  /**
   * Text that can run long (a pause reason, a pull request's title): it wraps rather than
   * truncating, breaking a long path or URL anywhere, and the actions drop under it when
   * there's no room beside it.
   */
  wrap?: boolean
  role?: 'status' | 'alert'
  className?: string
  /** For a height from shared layout, e.g. lining up with the window's toolbar */
  style?: CSSProperties
  children: ReactNode
}

/**
 * A bar across the top or bottom of a panel about the whole of it: the env file in use, the
 * dev server stopped. 36px, one line that truncates, actions at the end (bar recipe); with
 * `wrap`, at least 36px and as many lines as it needs.
 */
export function Banner({
  icon: Icon,
  tone = 'neutral',
  actions,
  edge = 'top',
  wrap = false,
  role,
  className,
  style,
  children,
}: BannerProps) {
  return (
    <div
      role={role}
      style={style}
      className={cn(
        'flex shrink-0 items-center gap-2 pr-1.5 pl-3 text-small',
        wrap ? 'min-h-9 flex-wrap gap-y-1.5 py-1.5' : 'h-9',
        edge === 'top' ? 'border-b border-line' : 'border-t border-line',
        BANNER_TONE[tone],
        className,
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {wrap ? (
        <div className="min-w-0 flex-1 basis-40 text-pretty wrap-anywhere">{children}</div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{children}</div>
      )}
      {actions && (
        <div className={cn('flex shrink-0 items-center gap-1', wrap && 'flex-wrap')}>{actions}</div>
      )}
    </div>
  )
}

/** A row's inset in a List (row recipe), for ListItem, a flush ListRow and their kin. */
const ROW_INSET = 'px-3 py-2.5'

/** Rows in a bordered, raised box divided by hairlines: settings groups, the app chooser. */
export function List({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul
      className={cn(
        'divide-y divide-line overflow-hidden rounded-lg border border-line bg-raised',
        className,
      )}
      {...props}
    />
  )
}

interface ListItemProps {
  /** The row's name, at body size and medium weight */
  title: ReactNode
  titleId?: string
  /** A secondary line under the title (small, muted); a PathText for paths */
  detail?: ReactNode
  /** Controls at the end of the row */
  trailing?: ReactNode
  /** More lines under the detail: messages, errors, details toggles */
  children?: ReactNode
  /** start: trailing controls line up with the title rather than the row's middle */
  align?: 'center' | 'start'
  /** Dims the title, e.g. for something switched off */
  quiet?: boolean
}

/** A static row in a List: title, a secondary line, trailing controls. */
export function ListItem({
  title,
  titleId,
  detail,
  trailing,
  children,
  align = 'center',
  quiet = false,
}: ListItemProps) {
  return (
    <li
      className={cn('flex gap-3', ROW_INSET, align === 'center' ? 'items-center' : 'items-start')}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          id={titleId}
          className={cn('flex min-w-0 items-center gap-2 font-medium', quiet && 'text-muted')}
        >
          {title}
        </div>
        {detail && <div className="min-w-0 text-pretty text-small text-muted">{detail}</div>}
        {children}
      </div>
      {trailing && <div className="-my-1 flex shrink-0 items-center gap-2">{trailing}</div>}
    </li>
  )
}

interface ListRowProps extends Omit<ComponentProps<'button'>, 'title'> {
  /** The row's name, medium weight; a string truncates. A node lays out in a row (a name and its status). */
  title: ReactNode
  /** A secondary line: a PathText for paths */
  detail?: ReactNode
  /** Before the text: an agent's icon */
  leading?: ReactNode
  /** At the end: a chevron when it leads somewhere */
  trailing?: ReactNode
  /** Edge to edge inside a List; otherwise a rounded row in open space */
  flush?: boolean
  /** The one in use: accent-soft, with no hover (give it aria-current) */
  selected?: boolean
}

/** A selectable row: a recent project, an app to preview, an agent. */
export function ListRow({
  title,
  detail,
  leading,
  trailing,
  flush = false,
  selected = false,
  className,
  ...props
}: ListRowProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full min-w-0 items-center gap-3 text-left transition-[background-color,opacity] disabled:pointer-events-none',
        selected ? 'bg-accent-soft' : `hover:bg-hover ${PRESS}`,
        flush ? `${ROW_INSET} focus-visible:-outline-offset-2` : 'rounded-md px-2 py-1.5',
        className,
      )}
      {...props}
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          {typeof title === 'string' ? (
            <span className="truncate" title={title}>
              {title}
            </span>
          ) : (
            title
          )}
        </span>
        {detail && (
          <span
            className="min-w-0 truncate text-caption text-subtle"
            title={typeof detail === 'string' ? detail : undefined}
          >
            {detail}
          </span>
        )}
      </span>
      {trailing}
    </button>
  )
}

const MESSAGE_TONE = {
  neutral: 'bg-fill text-muted',
  accent: 'bg-accent-soft text-accent-text',
  danger: 'bg-danger-soft text-danger',
} as const

interface MessageProps {
  /** A 16px icon in a 32px circle, so titles sit at the same height in every state; loading: a spinner */
  icon: IconComponent | 'loading'
  /** The circle's color: danger for errors, accent for a success, neutral otherwise */
  tone?: keyof typeof MESSAGE_TONE
  /** Leave it out when the explanation says it all */
  title?: ReactNode
  /** Plain explanation under the title */
  children?: ReactNode
  /** Buttons, under the text: at most one primary */
  actions?: ReactNode
  /**
   * Takes the rest of a panel or sheet with nothing else to show, and sits in the middle of it
   * at the empty-state inset, scrolling if it doesn't fit.
   */
  fill?: boolean
  className?: string
}

/**
 * The layout for empty, loading, error and done states, left-aligned: icon, title, explanation,
 * actions. On the canvas it sits in a Card; in a panel it fills the space (`fill`).
 */
export function Message({
  icon: Icon,
  tone = 'neutral',
  title,
  children,
  actions,
  fill = false,
  className,
}: MessageProps) {
  const message = (
    <div
      className={cn(
        'flex flex-col items-start gap-3 text-left wrap-anywhere',
        fill && 'my-auto w-full max-w-sm shrink-0',
        className,
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full',
          MESSAGE_TONE[tone],
        )}
      >
        {Icon === 'loading' ? (
          <Spinner size="md" />
        ) : (
          <Icon className="size-4" aria-hidden="true" />
        )}
      </span>
      <div className="flex flex-col gap-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="flex flex-col gap-1 text-pretty text-muted">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
  if (!fill) return message
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">{message}</div>
}

interface ThumbnailProps {
  /** An image URL; without one, `children` fill the box (a spinner while it's prepared) */
  src?: string
  alt?: string
  title?: string
  /** sm: 36px (the picked element). md: 56px (attached images). */
  size?: 'sm' | 'md'
  /**
   * cover crops to fill; contain shows all of it. element (picked crops): all of it, unless
   * it's a long strip (a heading, a nav bar) that would shrink to a line, when it fills from
   * its start so its first words show.
   */
  fit?: 'cover' | 'contain' | 'element'
  /** Shows a remove button on the corner */
  onRemove?: () => void
  /** The remove button's accessible name, e.g. "Remove hero.png" */
  removeLabel?: string
  children?: ReactNode
}

/** A small image at a fixed size, optionally removable. */
export function Thumbnail({
  src,
  alt = '',
  title,
  size = 'md',
  fit = 'cover',
  onRemove,
  removeLabel,
  children,
}: ThumbnailProps) {
  const [strip, setStrip] = useState(false)
  const contain = fit === 'contain' || (fit === 'element' && !strip)
  return (
    <div className="relative shrink-0">
      <div
        title={title}
        className={cn(
          'flex items-center justify-center overflow-hidden border border-line bg-canvas text-subtle',
          size === 'sm' ? 'size-9 rounded-md' : 'size-14 rounded-lg',
        )}
      >
        {src ? (
          <img
            src={src}
            alt={alt}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget
              setStrip(width > height * 3 || height > width * 3)
            }}
            className={cn(
              'size-full',
              contain ? 'object-contain' : 'object-cover',
              fit === 'element' && 'object-left-top',
            )}
          />
        ) : (
          children
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? 'Remove'}
          title={removeLabel ?? 'Remove'}
          onClick={onRemove}
          // 20px drawn, 32px to hit; neighbouring thumbnails are at least 44px apart.
          className={`absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-line-strong bg-raised text-muted shadow-control transition-[color,opacity] before:absolute before:-inset-1.75 before:rounded-full hover:text-fg hover:tint ${PRESS}`}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
