import { extendTailwindMerge } from 'tailwind-merge'

/*
 * Joins class names, and where two set the same thing (`pl-3` then `pl-1.5`), the later one
 * wins, so a `className` passed to a component overrides its defaults. tailwind-merge knows
 * Tailwind's own scales; these are Gui's (styles.css), so `text-small` reads as a size rather
 * than a color, and `z-chrome` as a layer.
 */
const merge = extendTailwindMerge({
  override: {
    theme: {
      color: [
        'canvas',
        'surface',
        'raised',
        'line',
        'line-strong',
        'fill',
        'hover',
        'fg',
        'muted',
        'subtle',
        'accent',
        'accent-hover',
        'accent-fg',
        'accent-soft',
        'accent-text',
        'success',
        'success-soft',
        'warning',
        'warning-soft',
        'danger',
        'danger-soft',
        'knob',
        'edge',
        'tile',
        'tile-fg',
        'tile-edge',
        'scrim',
        'current',
        'transparent',
        'inherit',
      ],
      text: ['caption', 'small', 'body', 'title'],
      shadow: ['raised', 'popover', 'panel', 'sheet', 'control'],
      radius: ['sm', 'md', 'lg', 'xl'],
      ease: ['out', 'in', 'spring'],
      animate: ['spin', 'row-in', 'row-fade', 'place-in', 'click-ring', 'sweep', 'fade-in'],
    },
  },
  extend: {
    classGroups: {
      z: [{ z: ['sticky', 'chrome', 'popover'] }],
    },
  },
})

export function cn(...classes: (string | false | null | undefined)[]) {
  return merge(...classes)
}
