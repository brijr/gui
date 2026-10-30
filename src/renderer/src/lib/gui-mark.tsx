import { cn } from './cn'

const TILES = [
  { x: 0, y: 0, fill: '#0066FF' },
  { x: 0, y: 30.6667, fill: '#7CB0FF' },
  { x: 0, y: 61.3333, fill: '#4590FF' },
  { x: 30.6667, y: 61.3333, fill: '#1E78FF' },
  { x: 61.3333, y: 30.6667, fill: '#5A9CFF' },
  { x: 61.3333, y: 0, fill: '#1F78FF' },
]

/** Gui’s pixel G, from the app icon. */
export function GuiMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 92 92"
      fill="none"
      aria-hidden="true"
      className={cn('pointer-events-none size-8 overflow-hidden select-none', className)}
    >
      {TILES.map((tile) => (
        <rect key={`${tile.x}:${tile.y}`} {...tile} width="30.6667" height="30.6667" />
      ))}
    </svg>
  )
}
