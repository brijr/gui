import type { CSSProperties } from 'react'
import { cn } from './cn'

/**
 * The mark's tiles, in the order they slide in: counterclockwise from the top left, down the
 * side, along the bottom, up the right. `from` is where each slides in from, in tile widths:
 * the slot of the tile before it, or above the mark for the first. The bar goes round the
 * empty bottom-right corner, by way of `via`.
 */
const TILES: { x: number; y: number; fill: string; from: string; via?: string }[] = [
  { x: 0, y: 0, fill: '#0066FF', from: 'translate(0, -100%)' },
  { x: 0, y: 30.6667, fill: '#7CB0FF', from: 'translate(0, -100%)' },
  { x: 0, y: 61.3333, fill: '#4590FF', from: 'translate(0, -100%)' },
  { x: 30.6667, y: 61.3333, fill: '#1E78FF', from: 'translate(-100%, 0)' },
  {
    x: 61.3333,
    y: 30.6667,
    fill: '#5A9CFF',
    from: 'translate(-100%, 100%)',
    via: 'translate(0, 100%)',
  },
  { x: 61.3333, y: 0, fill: '#1F78FF', from: 'translate(0, 100%)' },
]

/** Between one tile starting and the next: the one before has all but landed, so it covers this one's start. */
const STAGGER_MS = 115

/**
 * Gui's mark, the pixel G from the app icon (build/icon.icon/Assets/mark.svg). `animated`
 * assembles it when it mounts, each tile sliding into its slot, counterclockwise from the top left
 * (www/public/mark-animated.svg is the same as a standalone file).
 */
export function GuiMark({ className, animated }: { className?: string; animated?: boolean }) {
  // Painted last tile first, so each slides out from under the one before it.
  const tiles = TILES.map((tile, i) => ({ ...tile, i })).reverse()
  return (
    <svg
      viewBox="0 0 92 92"
      fill="none"
      aria-hidden="true"
      className={cn(
        'size-8 overflow-hidden',
        animated && 'motion-reduce:animate-row-fade',
        className,
      )}
    >
      {tiles.map((tile) => (
        <rect
          key={tile.i}
          x={tile.x}
          y={tile.y}
          width="30.6667"
          height="30.6667"
          fill={tile.fill}
          className={cn(
            animated && '[transform-box:fill-box] motion-reduce:animate-none',
            animated && (tile.via ? 'animate-mark-turn' : 'animate-mark-tile'),
          )}
          style={
            animated
              ? ({
                  '--from': tile.from,
                  '--via': tile.via,
                  animationDelay: `${tile.i * STAGGER_MS}ms`,
                } as CSSProperties)
              : undefined
          }
        />
      ))}
    </svg>
  )
}
