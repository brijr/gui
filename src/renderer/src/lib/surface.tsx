import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn'
import { Check, X } from './icons'
import { PRESS } from './ui'

/*
 * Surfaces and layouts: containers, lists and the centered message. Panels and sheets are
 * radius-xl; cards, popovers, menus and thumbnails radius-lg; rows and controls radius-md.
 */

interface CardProps extends ComponentProps<'div'> {
  /**
   * raised (default): a card on the canvas, white with a subtle shadow (setup, agent).
   * inset: a card inside a panel, on the surface color (permission, plan, queue, problems).
   */
  tone?: 'raised' | 'inset'
  as?: 'div' | 'section'
}

/** A bordered container. Padding is the caller's: content decides how much it needs. */
export function Card({ tone = 'raised', as: Tag = 'div', className, ...props }: CardProps) {
  return (
    <Tag
      className={cn(
        'rounded-lg border border-line',
        tone === 'raised' ? 'bg-raised shadow-raised' : 'bg-surface',
        className,
      )}
      {...props}
    />
  )
}

interface PopoverProps extends ComponentProps<'div'> {
  /**
   * False while it closes: it goes back the way it came, quickly, and takes no input. Keep it
   * mounted for --motion-exit (usePresence) so the close can play.
   */
  open?: boolean
}

/**
 * The floating surface for menus and pickers. It opens out of what opened it: give it a
 * `transformOrigin` at the trigger's edge in `style` (with its position), and it grows from
 * 97% there and fades in on the default spring's curve; it closes back into it. With reduced
 * motion it only fades.
 */
export function Popover({ open = true, className, ...props }: PopoverProps) {
  return (
    <div
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-line bg-raised text-fg shadow-popover',
        'transition-[opacity,scale] duration-(--motion-spring) ease-spring starting:opacity-0 motion-safe:starting:scale-97',
        'data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 data-[state=closed]:duration-(--motion-exit) data-[state=closed]:ease-in motion-safe:data-[state=closed]:scale-97',
        'motion-reduce:duration-(--motion-fade) motion-reduce:ease-linear',
        className,
      )}
      {...props}
    />
  )
}

interface MenuRowProps extends ComponentProps<'div'> {
  /** Under the keyboard or pointer */
  highlighted: boolean
  /** The current choice: a check at the end */
  selected: boolean
}

/** An option in a popover menu or listbox, 28px tall. Give it role="option" and its handlers. */
export function MenuRow({ highlighted, selected, className, children, ...props }: MenuRowProps) {
  return (
    <div
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-small transition-opacity',
        PRESS,
        highlighted && 'bg-hover',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check className="size-3 shrink-0 text-accent-text" aria-hidden="true" />}
    </div>
  )
}

interface GroupLabelProps {
  children: ReactNode
  id?: string
  as?: 'h2' | 'h3' | 'p' | 'div' | 'span' | 'figcaption'
  className?: string
}

/** Names a group of rows or controls: caption, medium, subtle, sentence case. */
export function GroupLabel({ children, id, as: Tag = 'p', className }: GroupLabelProps) {
  return (
    <Tag id={id} className={cn('text-caption font-medium text-subtle', className)}>
      {children}
    </Tag>
  )
}

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
      className={cn('flex gap-3 px-3 py-2.5', align === 'center' ? 'items-center' : 'items-start')}
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
  title: ReactNode
  /** A secondary line: a PathText for paths */
  detail?: ReactNode
  /** At the end: a chevron when it leads somewhere */
  trailing?: ReactNode
  /** Edge to edge inside a List; otherwise a rounded row in open space */
  flush?: boolean
}

/** A selectable row: a recent project, an app to preview. */
export function ListRow({
  title,
  detail,
  trailing,
  flush = false,
  className,
  ...props
}: ListRowProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full min-w-0 items-center gap-3 text-left transition-[background-color,opacity] hover:bg-hover',
        PRESS,
        flush ? 'px-3 py-2 focus-visible:-outline-offset-2' : 'rounded-md px-2 py-1.5',
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        {detail && <span className="min-w-0 text-caption text-subtle">{detail}</span>}
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
  /** A 16px icon or a md Spinner, shown in a 32px circle so titles sit at the same height in every state */
  icon: ReactNode
  /** The circle's color: danger for errors, accent for a success, neutral otherwise */
  tone?: keyof typeof MESSAGE_TONE
  /** Leave it out when the explanation says it all */
  title?: ReactNode
  /** Plain explanation under the title */
  children?: ReactNode
  /** Buttons, under the text: at most one primary */
  actions?: ReactNode
  className?: string
}

/**
 * The layout for empty, loading, error and done states, left-aligned: icon, title, explanation,
 * actions. On the canvas it sits in a Card; in the chat panel on its own.
 */
export function Message({
  icon,
  tone = 'neutral',
  title,
  children,
  actions,
  className,
}: MessageProps) {
  return (
    <div className={cn('flex flex-col items-start gap-3 text-left', className)}>
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full',
          MESSAGE_TONE[tone],
        )}
      >
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="flex flex-col gap-1 text-pretty text-muted">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

interface ThumbnailProps {
  /** An image URL; without one, `children` fill the box (a spinner while it's prepared) */
  src?: string
  alt?: string
  title?: string
  /** sm: 36px (the picked element). md: 56px (attached images). */
  size?: 'sm' | 'md'
  /** cover crops to fill; contain shows all of it (element crops) */
  fit?: 'cover' | 'contain'
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
            className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain')}
          />
        ) : (
          children
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? 'Remove'}
          title="Remove"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-line-strong bg-raised text-muted transition-colors hover:text-fg hover:tint"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
