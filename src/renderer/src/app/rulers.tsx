import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { RULER_SIZE } from '../../../shared/layout'
import type { RulerGuide, RulersView } from '../../../shared/types'
import { gui } from '../lib/api'

/** Labelled marks at least this far apart on screen (px); the steps between are 1, 2 and 5. */
const LABEL_SPACING = 64
/** Small marks between labels, no closer than this (px). */
const MARK_SPACING = 6
const LABEL_FONT = '10px -apple-system, BlinkMacSystemFont, system-ui, sans-serif'

/**
 * The rulers along the canvas's top and left edges (⇧R), in the page's CSS pixels: the units
 * of its CSS, at any viewport and zoom, and down the side as far as it's scrolled. Dragging out
 * of one makes a guide (main/guides.ts): the top one a horizontal line, the left one a vertical
 * one. The guide under the pointer, or being dragged, shows where it is on its ruler.
 */
export function Rulers() {
  const [view, setView] = useState<RulersView | null>(null)
  useEffect(() => gui.onRulers(setView), [])
  if (!view) return null
  return (
    <>
      <Ruler side="top" view={view} />
      <Ruler side="left" view={view} />
      <div
        aria-hidden="true"
        className="absolute top-0 left-0 border-r-hairline border-b-hairline border-line bg-surface"
        style={{ width: RULER_SIZE, height: RULER_SIZE }}
      />
    </>
  )
}

/**
 * One ruler. The top one measures x and makes `y` guides (horizontal lines); the left one
 * measures y and makes `x` guides.
 */
function Ruler({ side, view }: { side: 'top' | 'left'; view: RulersView }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [length, setLength] = useState(0)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const pressed = useRef<number | null>(null)
  const top = side === 'top'
  /** What this ruler measures, and what its marks are for */
  const measures: RulerGuide['axis'] = top ? 'x' : 'y'
  /** What dragging out of it makes */
  const makes: RulerGuide['axis'] = top ? 'y' : 'x'

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect
      if (box) setLength(Math.round(top ? box.width : box.height))
    })
    observer.observe(el)
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => setDark(scheme.matches)
    scheme.addEventListener('change', onScheme)
    return () => {
      observer.disconnect()
      scheme.removeEventListener('change', onScheme)
    }
  }, [top])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the token colors change with `dark`.
  useEffect(() => {
    const el = canvas.current
    if (el && length > 0) draw(el, view, measures, length)
  }, [view, measures, length, dark])

  /** The pointer in the preview view's coordinates (negative: over this ruler, off the page). */
  const pointAt = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    // The ruler's own corner is the canvas's (RULER_SIZE) along the other edge.
    const canvasX = event.clientX - box.left + (top ? RULER_SIZE : 0)
    const canvasY = event.clientY - box.top + (top ? 0 : RULER_SIZE)
    return { x: canvasX - view.page.x, y: canvasY - view.page.y }
  }

  const active = view.active?.axis === measures && !view.active.removing ? view.active : null
  const scroll = measures === 'x' ? view.scroll.x : view.scroll.y
  const pageStart = (measures === 'x' ? view.page.x : view.page.y) - RULER_SIZE

  return (
    <div
      data-ruler={side}
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.button !== 0 || pressed.current !== null) return
        pressed.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (event.pointerId === pressed.current) gui.rulerDrag(makes, 'move', pointAt(event))
      }}
      onPointerUp={(event) => {
        if (event.pointerId !== pressed.current) return
        pressed.current = null
        gui.rulerDrag(makes, 'end', pointAt(event))
      }}
      onLostPointerCapture={(event) => {
        if (event.pointerId !== pressed.current) return
        pressed.current = null
        gui.rulerDrag(makes, 'cancel', pointAt(event))
      }}
      className={
        top
          ? 'absolute top-0 right-0 cursor-row-resize border-b-hairline border-line bg-surface'
          : 'absolute bottom-0 left-0 cursor-col-resize border-r-hairline border-line bg-surface'
      }
      style={
        top ? { left: RULER_SIZE, height: RULER_SIZE } : { top: RULER_SIZE, width: RULER_SIZE }
      }
    >
      <canvas ref={canvas} className="block size-full" />
      {active && (
        <span
          data-ruler-position=""
          className="pointer-events-none absolute flex h-4 items-center rounded-sm bg-accent px-1 text-caption whitespace-nowrap text-accent-fg tabular-nums"
          // Centered on the guide's line, across the ruler; the left one's reads upward.
          style={{
            left: top ? pageStart + (active.at - scroll) * view.scale : RULER_SIZE / 2,
            top: top ? RULER_SIZE / 2 : pageStart + (active.at - scroll) * view.scale,
            transform: `translate(-50%, -50%)${top ? '' : ' rotate(-90deg)'}`,
          }}
        >
          {measures} {Math.round(active.at)}
        </span>
      )}
    </div>
  )
}

/**
 * Draws a ruler `length` long that measures `axis`: marks and numbers over the page only, each
 * guide on that axis as an accent mark.
 */
function draw(el: HTMLCanvasElement, view: RulersView, axis: RulerGuide['axis'], length: number) {
  const ratio = window.devicePixelRatio
  const top = axis === 'x'
  const width = top ? length : RULER_SIZE
  const height = top ? RULER_SIZE : length
  if (el.width !== width * ratio) el.width = width * ratio
  if (el.height !== height * ratio) el.height = height * ratio
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const styles = getComputedStyle(el)
  const subtle = styles.getPropertyValue('--subtle')
  const accent = styles.getPropertyValue('--accent')

  const { scale } = view
  const scroll = top ? view.scroll.x : view.scroll.y
  // Where the page starts along this ruler, and how long it is on screen.
  const start = (top ? view.page.x : view.page.y) - RULER_SIZE
  const span = top ? view.page.width : view.page.height
  /** Page pixels to this ruler's */
  const toRuler = (at: number) => start + (at - scroll) * scale
  const from = scroll
  const to = scroll + span / scale

  const step = labelStep(scale)
  const parts = [10, 5, 2].find((each) => (step / each) * scale >= MARK_SPACING) ?? 1
  const minor = step / parts
  ctx.fillStyle = subtle
  ctx.font = LABEL_FONT
  ctx.textBaseline = 'top'
  const mark = (at: number, size: number) => {
    const p = Math.round(toRuler(at))
    if (top) ctx.fillRect(p, RULER_SIZE - size, 1, size)
    else ctx.fillRect(RULER_SIZE - size, p, size, 1)
  }
  for (let i = Math.ceil(from / minor); i * minor <= to; i++) {
    if (i % parts !== 0) mark(i * minor, 4)
  }
  for (let i = Math.ceil(from / step); i * step <= to; i++) {
    const at = i * step
    mark(at, RULER_SIZE)
    const label = String(Math.round(at))
    const p = Math.round(toRuler(at)) + 3
    if (top) ctx.fillText(label, p, 3)
    else {
      ctx.save()
      ctx.translate(3, p)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'right'
      ctx.fillText(label, 0, 0)
      ctx.restore()
    }
  }
  ctx.fillStyle = accent
  for (const guide of view.guides) {
    if (guide.axis !== axis || guide.at < from || guide.at > to) continue
    mark(guide.at, RULER_SIZE)
  }
}

/** The page pixels between labels: 1, 2 or 5 times a power of ten, far enough apart on screen. */
function labelStep(scale: number) {
  const least = LABEL_SPACING / scale
  const power = 10 ** Math.floor(Math.log10(least))
  return [1, 2, 5, 10].map((each) => each * power).find((each) => each >= least) ?? power * 10
}
