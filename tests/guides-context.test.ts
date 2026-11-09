import { describe, expect, test } from 'bun:test'
import {
  alignGuides,
  describeAlignment,
  MAX_NEAR_MISSES,
  type PageBox,
} from '../src/main/guide-alignment'
import { buildPrompt, describeGuides } from '../src/main/prompt'
import { pageRect } from '../src/shared/coords'
import type { RulerGuide } from '../src/shared/types'

const box = (label: string, x: number, y: number, width: number, height: number): PageBox => ({
  selector: `#${label}`,
  label,
  rect: pageRect(x, y, width, height),
})

const vertical = (at: number): RulerGuide => ({ axis: 'x', at })
const horizontal = (at: number): RulerGuide => ({ axis: 'y', at })

const prompt = (guides: Parameters<typeof buildPrompt>[0]['guides'], tools = true) =>
  buildPrompt({
    text: 'Line up the cards',
    selection: [],
    viewport: { name: 'Desktop', width: 1280, height: 800, fixed: false },
    guides,
    problems: [],
    preamble: false,
    tools,
    images: true,
    attachments: [],
  })
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .filter((text) => text.startsWith('Guides'))

describe('the guides line in each message', () => {
  test('names each axis in order, at the viewport width', () => {
    expect(
      describeGuides({
        width: 1280,
        guides: [vertical(1208), horizontal(120), vertical(72)],
      }),
    ).toBe('Guides (page pixels, at 1280px wide): vertical at 72, 1208; horizontal at 120.')
    expect(describeGuides({ width: 390.4, guides: [horizontal(64.25)] })).toBe(
      'Guides (page pixels, at 390px wide): horizontal at 64.3.',
    )
  })

  test('goes with the message when there are guides, with or without preview tools', () => {
    const guides = { width: 1280, guides: [vertical(72)] }
    expect(prompt(guides)).toEqual(['Guides (page pixels, at 1280px wide): vertical at 72.'])
    expect(prompt(guides, false)).toHaveLength(1)
  })

  test('is left out with the rulers off or no guides', () => {
    expect(prompt(null)).toEqual([])
    expect(prompt({ width: 1280, guides: [] })).toEqual([])
  })
})

describe('near misses', () => {
  test('lists edges a few pixels off a guide, closest first, and counts the ones on it', () => {
    const guides = [vertical(72), horizontal(120)]
    const { onGuide, misses, more } = alignGuides(guides, [
      box('pricing', 75, 300, 200, 100), // left edge 3px right of 72
      box('hero', 72, 0, 400, 118), // left on 72; bottom 2px above 120
      box('logo', 64, 20, 4, 4), // right edge 4px left of 72
      box('far', 500, 500, 10, 10),
      box('wide', 71.7, 600, 10, 10), // within half a pixel of 72: on it
    ])
    expect(onGuide).toEqual([2, 0])
    expect(more).toBe(0)
    expect(misses.map(({ box, edge, offset }) => [box.label, edge, offset])).toEqual([
      ['hero', 'bottom', -2],
      ['pricing', 'left', 3],
      ['logo', 'right', -4],
    ])
  })

  test('ignores edges on the guide or further than 8px away', () => {
    const { misses } = alignGuides(
      [vertical(100)],
      [box('on', 100, 0, 50, 50), box('far', 108.5, 0, 50, 50), box('edge', 108, 0, 50, 50)],
    )
    expect(misses.map((miss) => miss.box.label)).toEqual(['edge'])
  })

  test('keeps the largest of nested elements sharing an edge', () => {
    const { misses } = alignGuides(
      [vertical(72)],
      [box('inner', 75, 10, 100, 20), box('card', 75, 0, 300, 200)],
    )
    expect(misses.map((miss) => miss.box.label)).toEqual(['card'])
  })

  test('caps the list and counts the rest', () => {
    const boxes = Array.from({ length: MAX_NEAR_MISSES + 5 }, (_, i) =>
      box(`b${i}`, 72.5 + i * 0.3, i * 100, 10, 10),
    )
    const { misses, more } = alignGuides([vertical(72)], boxes)
    expect(misses).toHaveLength(MAX_NEAR_MISSES)
    expect(more).toBe(5)
  })

  test('reads as one line per miss, with the side and a selector', () => {
    const guides = [vertical(72), horizontal(120)]
    const pricing = { ...box('pricing', 75, 300, 200, 100), label: 'div.card "Pricing"' }
    const text = describeAlignment(guides, alignGuides(guides, [pricing]), {
      width: 1280,
      scroll: { x: 0, y: 40 },
    })
    expect(text).toContain('with the viewport 1280px wide (scrolled to 0, 40)')
    expect(text).toContain('- vertical at 72\n- horizontal at 120')
    expect(text).toContain(
      '- div.card "Pricing" left edge at 75, 3px right of the vertical guide at 72. Selector: #pricing',
    )
    expect(
      describeAlignment(guides, alignGuides(guides, []), { width: 1280, scroll: { x: 0, y: 0 } }),
    ).toContain('No element edge is within 8px')
  })
})
