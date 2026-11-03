import { type MouseEvent, type ReactNode, useEffect, useId, useRef } from 'react'
import { cn } from './cn'
import { X } from './icons'
import { PanelHeader } from './surface'
import { IconButton, TIGHT_HIT_AREA } from './ui'

interface DialogProps {
  open: boolean
  /** Esc, the close button or a click on the backdrop; set `open` false to close it */
  onClose: () => void
  /**
   * Once it has closed and the page is no longer inert: the moment focus can move back to
   * something other than what opened it
   */
  onClosed?: () => void
  /** Named in the header; also the dialog's accessible name */
  heading: ReactNode
  /** More actions in the header, before Close */
  actions?: ReactNode
  /** md: text and lists (512px). lg: media (672px). */
  size?: 'md' | 'lg'
  /** Buttons along the bottom, primary last */
  footer?: ReactNode
  /**
   * Focus the dialog's body rather than its first control, so the arrow keys scroll it and
   * no button starts with a focus ring (a sheet that's only read)
   */
  focusSelf?: boolean
  /** The body's insets and layout; px-4 py-3 by default */
  className?: string
  children: ReactNode
}

/**
 * The one modal: a sheet over the window with a header (heading, actions, Close), a body that
 * scrolls under it, and an optional footer. It grows in from 97% and fades on
 * --motion-panel, over a fading scrim, and goes back the way it came; with reduced motion it
 * only fades. Focus returns to what opened it. Main hides the preview and chat views while
 * one is open in the window's own page, since they sit on top of it.
 */
export function Dialog({
  open,
  onClose,
  onClosed,
  heading,
  actions,
  size = 'md',
  footer,
  focusSelf = false,
  className,
  children,
}: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      element.showModal()
      // The body is what scrolls, so it takes the keys.
      if (focusSelf) body.current?.focus()
    } else if (!open && element.open) {
      element.close()
    }
  }, [open, focusSelf])

  // The backdrop is the dialog's own box, outside its content.
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it (onCancel); this is a click on the backdrop
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Closed through `open`, so the caller's state stays the truth.
        event.preventDefault()
        onClose()
      }}
      onClick={onClick}
      onClose={onClosed}
      className={cn(
        'no-drag m-auto flex w-full flex-col overflow-hidden rounded-xl border border-line bg-overlay p-0 text-fg shadow-sheet outline-none not-open:hidden backdrop:bg-scrim',
        size === 'md' ? 'max-w-lg' : 'max-w-2xl',
        // In and out: the dialog and its backdrop stay in the top layer while they fade.
        'transition-[opacity,scale,display,overlay] transition-discrete duration-(--motion-panel) ease-out',
        'opacity-0 open:opacity-100 starting:open:opacity-0',
        'motion-safe:scale-97 motion-safe:open:scale-100 motion-safe:starting:open:scale-97',
        'backdrop:opacity-0 backdrop:transition-[opacity,display,overlay] backdrop:transition-discrete backdrop:duration-(--motion-panel) open:backdrop:opacity-100 starting:open:backdrop:opacity-0',
        'not-open:duration-(--motion-pop) not-open:ease-in not-open:backdrop:duration-(--motion-pop) not-open:backdrop:ease-in',
        // Reduced motion: both fade in the same short, even fade (closing keeps not-open:).
        'motion-reduce:duration-(--motion-fade) motion-reduce:ease-linear motion-reduce:backdrop:duration-(--motion-fade) motion-reduce:backdrop:ease-linear',
      )}
    >
      <PanelHeader
        heading={<h2 className="min-w-0 truncate font-semibold">{heading}</h2>}
        titleId={titleId}
        actions={
          <>
            {actions}
            <IconButton
              className={TIGHT_HIT_AREA}
              label="Close"
              title="Close (Esc)"
              icon={X}
              onClick={onClose}
            />
          </>
        }
      />
      <div
        ref={body}
        tabIndex={focusSelf ? -1 : undefined}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto scroll-stable overscroll-contain scroll-fade outline-none',
          className ?? 'px-3 py-3',
        )}
      >
        {children}
      </div>
      {footer && (
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t-hairline border-line px-3 py-2.5">
          {footer}
        </footer>
      )}
    </dialog>
  )
}
