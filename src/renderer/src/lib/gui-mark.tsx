import { cn } from './cn'

/** Gui's mark, the pixel G from the app icon (build/icon.icon/Assets/mark.svg). */
export function GuiMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 92 92" fill="none" aria-hidden="true" className={cn('size-8', className)}>
      <rect x="0" y="0" width="30.6667" height="30.6667" fill="#0066FF" />
      <rect x="61.3333" y="0" width="30.6667" height="30.6667" fill="#1F78FF" />
      <rect x="0" y="30.6667" width="30.6667" height="30.6667" fill="#7CB0FF" />
      <rect x="61.3333" y="30.6667" width="30.6667" height="30.6667" fill="#5A9CFF" />
      <rect x="0" y="61.3333" width="30.6667" height="30.6667" fill="#4590FF" />
      <rect x="30.6667" y="61.3333" width="30.6667" height="30.6667" fill="#1E78FF" />
    </svg>
  )
}
