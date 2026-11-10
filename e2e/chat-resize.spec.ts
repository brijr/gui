import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { PanelEdge, Turn, TurnItem } from '../src/shared/types'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

const PARAGRAPH =
  'The header now keeps its height while the menu opens, so the page under it no longer jumps. I moved the spacing into the layout so every breakpoint shares it.'
const BULLETS = [
  '- Moved the nav links into one list',
  '- Gave the menu button a label screen readers read out',
  '- Kept the logo the same size at every width',
  '- Checked the page at 375, 768 and 1280 pixels',
].join('\n')

/** A history as varied as a real one: short and long bubbles, step rows, files changed, lists. */
function turn(index: number): Turn {
  const started = Date.now() - 600_000 + index * 10_000
  const steps = [1, 15, 3, 7][index % 4]
  const text = [
    PARAGRAPH,
    index % 2 === 0 ? BULLETS : '',
    index % 3 === 0 ? `${PARAGRAPH} ${PARAGRAPH}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const items: TurnItem[] = [
    ...Array.from({ length: steps }, (_, step) => ({
      kind: 'tool' as const,
      id: `resize-tool-${index}-${step}`,
      title: `Read src/components/Header${step}.tsx`,
      toolKind: 'read',
      status: 'completed' as const,
      locations: [`src/components/Header${step}.tsx`],
      startedAt: started,
      endedAt: started + 55_000,
    })),
    { kind: 'text', id: `resize-text-${index}`, text },
  ]
  return {
    id: `resize-turn-${index}`,
    index,
    prompt:
      index % 3 === 1
        ? `Make the header sticky on scroll, keep the logo left-aligned, and make sure the mobile menu still opens over the page content (${index})`
        : `Tighten the header (${index})`,
    context: [],
    status: 'done',
    error: null,
    startedAt: started,
    endedAt: started + 55_000,
    reverted: false,
    changes: Array.from({ length: 1 + (index % 3) }, (_, file) => ({
      path: `src/components/Header${file}.tsx`,
      status: 'modified' as const,
      additions: 4,
      deletions: 2,
    })),
    items,
  }
}

const TURNS = 40

function seed(userData: string, root: string) {
  const name = createHash('sha1').update(realpathSync(root)).digest('hex').slice(0, 16)
  const chats = join(userData, 'chats')
  mkdirSync(chats, { recursive: true })
  writeFileSync(
    join(chats, `${name}.json`),
    JSON.stringify({
      version: 1,
      agentId: 'claude',
      sessionId: null,
      turns: Array.from({ length: TURNS }, (_, index) => turn(index)),
      checkpoints: {},
      redo: null,
    }),
  )
}

async function open(session: GuiSession) {
  seed(session.fixture.userData, session.fixture.root)
  await session.chrome.evaluate((root) => window.gui.openRecent(root), session.fixture.root)
  await session.waitForPreview()
  await session.chat.evaluate(() => window.gui.expandChat())
  const newest = `Tighten the header (${TURNS - 1})`
  await expect(session.chat.getByText(newest, { exact: true })).toBeVisible()
}

interface Drag {
  edge: PanelEdge
  /** Pixels per frame, then back the same way. */
  step: number
  frames: number
  /** A turn the user scrolled back to read, which should stay where it is on screen. */
  reading?: string
}

interface Samples {
  frames: number
  widths: number[]
  overlaps: string[]
  /** How far the newest turn's bottom is from the transcript's bottom, each frame. */
  newest: (number | null)[]
  /** Where the turn being read starts, from the transcript's top, each frame. */
  reading: (number | null)[]
  /** Errors the page raised meanwhile, such as a resize observer's loop. */
  errors: string[]
}

/**
 * Drags an edge of the chat one step per frame, as a pointer drag does, and checks every frame
 * the user could see. A frame's check runs in requestAnimationFrame, or, when the chat's width
 * changed since the last one, in a ResizeObserver made after the transcript's own: rAF runs
 * before that frame's resize observers, so its reading would not be what gets painted.
 */
function dragAndSample(page: Page, drag: Drag) {
  return page.evaluate(
    ({ edge, step, frames, reading, newestId }) =>
      new Promise<Samples>((resolve) => {
        const el = document.querySelector<HTMLElement>('[data-transcript]')
        if (!el) throw new Error('Missing transcript')
        const samples: Samples = {
          frames: 0,
          widths: [],
          overlaps: [],
          newest: [],
          reading: [],
          errors: [],
        }
        const onError = (event: ErrorEvent) => samples.errors.push(event.message)
        window.addEventListener('error', onError)
        const check = (where: string) => {
          samples.frames++
          const view = el.getBoundingClientRect()
          const rows = [...el.querySelectorAll<HTMLElement>('[data-turn-row]')]
            .map((row) => ({ id: row.dataset.turnRow ?? '', rect: row.getBoundingClientRect() }))
            .sort((a, b) => a.rect.top - b.rect.top)
          const seen = rows.filter(
            (row) => row.rect.bottom > view.top && row.rect.top < view.bottom,
          )
          for (let i = 1; i < seen.length; i++) {
            const over = seen[i - 1].rect.bottom - seen[i].rect.top
            if (over > 1) {
              samples.overlaps.push(
                `${where} at ${el.clientWidth}px: ${seen[i - 1].id} covers ${seen[i].id} by ${Math.round(over)}px`,
              )
            }
          }
          const newest = rows.find((row) => row.id === newestId)
          samples.newest.push(newest ? Math.round(view.bottom - newest.rect.bottom) : null)
          const read = rows.find((row) => row.id === reading)
          samples.reading.push(read ? Math.round(read.rect.top - view.top) : null)
          if (!samples.widths.includes(el.clientWidth)) samples.widths.push(el.clientWidth)
        }
        let checkedWidth = el.clientWidth
        const observer = new ResizeObserver(() => {
          checkedWidth = el.clientWidth
          check('resize')
        })
        observer.observe(el)
        let frame = 0
        const settle = 30
        const tick = () => {
          if (el.clientWidth === checkedWidth) check('frame')
          if (frame < frames * 2) {
            window.gui.resizeChat(edge, frame < frames ? -step : step, 0)
            if (frame === frames * 2 - 1) window.gui.endResizeChat()
          }
          frame++
          if (frame < frames * 2 + settle) requestAnimationFrame(tick)
          else {
            observer.disconnect()
            window.removeEventListener('error', onError)
            resolve(samples)
          }
        }
        requestAnimationFrame(tick)
      }),
    { ...drag, newestId: `resize-turn-${TURNS - 1}` },
  )
}

/** Every value the same as the first, within 2px. */
function steady(values: (number | null)[]) {
  const first = values[0]
  expect(first).not.toBeNull()
  return values.filter((value) => value === null || Math.abs(value - (first ?? 0)) > 2)
}

function expectClean(samples: Samples, held: 'end' | 'reading') {
  console.log(
    `[resize] ${samples.frames} frames over widths ${Math.min(...samples.widths)}–${Math.max(...samples.widths)}px, ${samples.overlaps.length} with overlapping rows`,
  )
  // It really resized, through many widths.
  expect(samples.widths.length).toBeGreaterThan(10)
  expect(samples.overlaps.slice(0, 10)).toEqual([])
  expect(samples.errors).toEqual([])
  // Scrolled to the end, it stays at the end: the newest turn sits at the bottom every frame.
  // Scrolled back, the turn being read stays put at the top.
  expect(steady(held === 'end' ? samples.newest : samples.reading)).toEqual([])
}

/**
 * Scrolls back with the wheel, as the user does (a scroll from a script counts as the layout's,
 * and the chat would go back to the end), then to a little way into a turn mid-transcript.
 */
async function scrollBack(page: Page) {
  const transcript = page.locator('[data-transcript]')
  await transcript.hover()
  await page.mouse.wheel(0, -1_000_000)
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0)
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2
  })
  const inView = () =>
    transcript.evaluate((el) => {
      const view = el.getBoundingClientRect()
      const row = [...el.querySelectorAll<HTMLElement>('[data-turn-row]')].find(
        (row) => row.getBoundingClientRect().bottom > view.top + 100,
      )
      return row?.dataset.turnRow ?? null
    })
  await expect.poll(inView).not.toBeNull()
  const reading = (await inView()) ?? ''
  await transcript.evaluate((el, id) => {
    const row = el.querySelector(`[data-turn-row="${id}"]`)
    if (!row) throw new Error(`Missing ${id}`)
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top + 8
  }, reading)
  return reading
}

test('the docked chat keeps its transcript in order and at the end while its edge is dragged', async ({
  launch,
}) => {
  const session = await launch({
    fixture: 'vite',
    open: 'recent',
    prefs: { chatSidebar: true, chatSidebarSide: 'left', chatSidebarWidth: 560 },
    reducedMotion: 'reduce',
  })
  await open(session)
  // The sidebar on the left is resized from its right edge: in toward 320px, and back out.
  expectClean(await dragAndSample(session.chat, { edge: 'right', step: 6, frames: 40 }), 'end')

  const reading = await scrollBack(session.chat)
  expectClean(
    await dragAndSample(session.chat, { edge: 'right', step: 6, frames: 40, reading }),
    'reading',
  )
})

test('the floating chat keeps its transcript in order and at the end while its corner is dragged', async ({
  launch,
}) => {
  const session = await launch({
    fixture: 'vite',
    open: 'recent',
    prefs: { chatSize: { width: 560, height: 600 } },
    reducedMotion: 'reduce',
  })
  await open(session)
  // At the bottom right, it's resized from its top-left corner: dragged right it narrows.
  expectClean(await dragAndSample(session.chat, { edge: 'top-left', step: -6, frames: 40 }), 'end')
})
