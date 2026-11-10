import { INK, INK_COUNT } from '../scene'

/*
 * The board's inks as the page's own theme has them: read from the CSS custom properties the
 * rest of the UI uses (styles.css), so light and dark never need saying twice.
 */

/** A CSS colour as premultiplied rgba, 0 to 1 each. */
function parse(color: string): [number, number, number, number] {
  const numbers = (color.match(/-?[\d.]+(?:e-?\d+)?%?/g) ?? []).map((part) =>
    part.endsWith('%') ? Number.parseFloat(part) / 100 : Number.parseFloat(part),
  )
  // `rgb(r, g, b)` and `rgba(r, g, b, a)` count to 255; `color(srgb r g b / a)` to 1.
  const unit = color.startsWith('color(') ? 1 : 255
  const [r = 0, g = 0, b = 0, a = 1] = numbers
  return [(r / unit) * a, (g / unit) * a, (b / unit) * a, a]
}

/** Every ink's colour for the theme `host` is in: INK_COUNT × premultiplied rgba. */
export function readInks(host: HTMLElement): Float32Array {
  const inks = new Float32Array(INK_COUNT * 4)
  const probe = document.createElement('span')
  probe.style.display = 'none'
  host.append(probe)
  const read = (value: string, alpha = 1) => {
    probe.style.color = value
    const [r, g, b, a] = parse(getComputedStyle(probe).color)
    return [r * alpha, g * alpha, b * alpha, a * alpha]
  }
  // A shadow's colour is the one colour in its value: `0 1px 2px rgb(0 0 0 / 0.06)`.
  const elevation = getComputedStyle(host).getPropertyValue('--elevation-raised')
  const shadow = elevation.match(/(?:rgba?|hsla?|color)\([^)]*\)|#[0-9a-f]{3,8}/i)?.[0]
  const colors: [number, number[]][] = [
    [INK.canvas, read('var(--canvas)')],
    [INK.raised, read('var(--raised)')],
    [INK.line, read('var(--line)')],
    [INK.lineStrong, read('var(--line-strong)')],
    [INK.section, read('var(--fill)', 0.6)],
    [INK.accent, read('var(--accent)')],
    [INK.accentSoft, read('var(--accent-soft)')],
    [INK.shadow, read(shadow ?? 'transparent')],
  ]
  for (const [ink, color] of colors) inks.set(color, ink * 4)
  probe.remove()
  return inks
}
