import type { PageRect } from '../shared/coords'
import type { RulerGuide } from '../shared/types'

/** An element's edge this close to a guide (page CSS pixels), but not on it, nearly lines up. */
export const NEAR_MISS = 8
/** Closer than this is on the guide: sub-pixel layout, not a miss. */
const ON_GUIDE = 0.5
/** The near misses listed, closest first; the rest are counted. */
export const MAX_NEAR_MISSES = 20

/** A visible element on the page, as preview_snapshot names it. */
export interface PageBox {
  /** A CSS selector for it, as preview_snapshot gives */
  selector: string
  /** Its tag, classes and text, short */
  label: string
  rect: PageRect
}

type Edge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

export interface NearMiss {
  guide: RulerGuide
  box: PageBox
  edge: Edge
  /** Where the edge is, in page pixels */
  at: number
  /** How far it is from the guide: positive is right of or below it */
  offset: number
}

export interface Alignment {
  /** Per guide, in order: how many elements have an edge exactly on it */
  onGuide: number[]
  /** Closest first, then larger elements first; at most MAX_NEAR_MISSES */
  misses: NearMiss[]
  /** Near misses past the cap */
  more: number
}

/** An element's edges along a guide's axis: x for a vertical guide, y for a horizontal one. */
function edges({ rect }: PageBox, axis: RulerGuide['axis']): [Edge, number][] {
  return axis === 'x'
    ? [
        ['left', rect.x],
        ['center', rect.x + rect.width / 2],
        ['right', rect.x + rect.width],
      ]
    : [
        ['top', rect.y],
        ['middle', rect.y + rect.height / 2],
        ['bottom', rect.y + rect.height],
      ]
}

const area = ({ rect }: PageBox) => rect.width * rect.height
const tenth = (value: number) => Math.round(value * 10) / 10

/**
 * Which elements line up with the guides, and which nearly do. Nested wrappers often share
 * an edge: of the elements with the same edge at the same place, only the largest is listed.
 */
export function alignGuides(guides: RulerGuide[], boxes: PageBox[]): Alignment {
  const onGuide = guides.map(() => 0)
  const found = new Map<string, NearMiss>()
  guides.forEach((guide, index) => {
    for (const box of boxes) {
      // An element already on the guide isn't off it; otherwise its closest edge is the miss.
      const [edge, at] = edges(box, guide.axis).sort(
        (a, b) => Math.abs(a[1] - guide.at) - Math.abs(b[1] - guide.at),
      )[0]
      const offset = at - guide.at
      const distance = Math.abs(offset)
      if (distance < ON_GUIDE) onGuide[index]++
      else if (distance <= NEAR_MISS) {
        const key = `${index}:${edge}:${tenth(at)}`
        const kept = found.get(key)
        if (!kept || area(box) > area(kept.box)) found.set(key, { guide, box, edge, at, offset })
      }
    }
  })
  const sorted = [...found.values()].sort(
    (a, b) => Math.abs(a.offset) - Math.abs(b.offset) || area(b.box) - area(a.box),
  )
  return {
    onGuide,
    misses: sorted.slice(0, MAX_NEAR_MISSES),
    more: Math.max(0, sorted.length - MAX_NEAR_MISSES),
  }
}

const direction = (axis: RulerGuide['axis']) => (axis === 'x' ? 'vertical' : 'horizontal')

const px = (value: number) => String(tenth(value))

function side({ guide, offset }: NearMiss) {
  if (guide.axis === 'x') return offset > 0 ? 'right of' : 'left of'
  return offset > 0 ? 'below' : 'above'
}

/** What preview_guides tells the agent: the guides, and the edges that just miss them. */
export function describeAlignment(
  guides: RulerGuide[],
  alignment: Alignment,
  page: { width: number; scroll: { x: number; y: number } },
) {
  const lines = [
    `Guides in page CSS pixels, with the viewport ${Math.round(page.width)}px wide (scrolled to ${Math.round(page.scroll.x)}, ${Math.round(page.scroll.y)}):`,
  ]
  guides.forEach((guide, index) => {
    const on = alignment.onGuide[index] ?? 0
    const count = on ? `: ${on === 1 ? '1 element has' : `${on} elements have`} an edge on it` : ''
    lines.push(`- ${direction(guide.axis)} at ${px(guide.at)}${count}`)
  })
  if (!alignment.misses.length) {
    lines.push(`No element edge is within ${NEAR_MISS}px of a guide without being on it.`)
    return lines.join('\n')
  }
  lines.push(
    `Near misses, closest first (visible elements with an edge within ${NEAR_MISS}px of a guide, not on it):`,
  )
  for (const miss of alignment.misses) {
    const { box, guide, edge, at, offset } = miss
    lines.push(
      `- ${box.label} ${edge} edge at ${px(at)}, ${px(Math.abs(offset))}px ${side(miss)} the ${direction(guide.axis)} guide at ${px(guide.at)}. Selector: ${box.selector}`,
    )
  }
  if (alignment.more) lines.push(`…and ${alignment.more} more.`)
  return lines.join('\n')
}
