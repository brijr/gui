import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  type BoardCamera,
  type BoardSection,
  boardBounds,
  sectionBounds,
} from '../../../shared/board'
import {
  type BoardViewPoint,
  boardPoint,
  boardRectFrom,
  boardViewFromBoard,
  boardViewPoint,
  boardViewRect,
  boardViewRectFromBoard,
} from '../../../shared/coords'
import { Spring } from '../../../shared/motion'
import type { BoardFrame } from '../../../shared/types'
import { onFrames, prefersReducedMotion } from '../lib/motion'
import { centreIn, clearArea, fitIn, shownShare, wheelBy, zoomAbout } from './camera'
import type { Area } from './gestures'
import { chatCover, sendIntent } from './intents'
import { GRID } from './scene'
import type { BoardSurfaceHandle } from './surface'
import { publishView } from './view'

/** Where the camera rests, saved this long after the last pan or zoom. */
const SAVE_CAMERA_MS = 400

type CameraUpdate = BoardCamera | null | ((current: BoardCamera | null) => BoardCamera | null)

/**
 * The board's camera, twice: `live`, where it is this moment, written straight to the board's
 * layer (and the canvas told) on every step of a pan or pinch without React; and `camera`,
 * React's copy, which follows 100 ms behind during a gesture and 150 ms after it rests, and
 * decides what's mounted. And everything that moves it but a drag: the wheel, fitting,
 * zooming about the middle, revealing a frame or the frames the agent adds, and the toolbar's
 * controls. Saved for the next time the canvas opens once it rests, and as the board goes
 * (opening a frame, another tab): main keeps it only for this canvas.
 */
export function useBoardCamera({
  initial,
  boardId,
  frames,
  sections,
  gesture,
  board,
  layer,
  surface,
  gl,
}: {
  initial: BoardCamera | null
  boardId: string
  /** Main's frames and sections */
  frames: BoardFrame[]
  sections: BoardSection[]
  /** The gesture under way: the wheel waits for it, and so do frames added out of sight */
  gesture: RefObject<unknown>
  /** The board's element, whose background is the dot grid (unless the canvas draws it) */
  board: RefObject<HTMLElement | null>
  /** The layer in board pixels that the camera moves and scales */
  layer: RefObject<HTMLElement | null>
  surface: RefObject<BoardSurfaceHandle | null>
  gl: boolean
}) {
  const [camera, commitCamera] = useState<BoardCamera | null>(initial)
  /** The board's size on screen, in board-view pixels */
  const [size, setSize] = useState({ width: 0, height: 0 })
  const live = useRef(camera)
  const timers = useRef<{
    cull?: ReturnType<typeof setTimeout>
    rest?: ReturnType<typeof setTimeout>
  }>({})
  const unsaved = useRef<BoardCamera | null>(null)
  const draw = () => {
    const current = live.current
    if (!current || !board.current || !layer.current) return
    const { zoom } = current
    const origin = boardViewFromBoard(boardPoint(0, 0), current)
    layer.current.style.transform = `translate(${origin.x}px, ${origin.y}px) scale(${zoom})`
    // What's drawn at screen size in the layer reads these, so it keeps up with every frame of
    // a pan or pinch rather than with the throttled `camera`.
    layer.current.style.setProperty('--board-px', `${1 / zoom}px`)
    layer.current.style.setProperty('--board-zoom', String(zoom))
    layer.current.style.setProperty('--board-unzoom', String(1 / zoom))
    surface.current?.invalidate()
    if (gl) return
    board.current.style.backgroundPosition = `${origin.x}px ${origin.y}px`
    board.current.style.backgroundSize = `${GRID * zoom}px ${GRID * zoom}px`
  }
  const flight = useRef<(() => void) | null>(null)
  /** The camera's position on its way, kept while it glides so a new glide keeps its speed */
  const springs = useRef<{ x: Spring; y: Spring } | null>(null)
  const stopFlight = () => {
    flight.current?.()
    flight.current = null
    springs.current = null
  }
  /** Where the camera is now, for React too. */
  const setCamera = (next: CameraUpdate) => {
    stopFlight()
    live.current = typeof next === 'function' ? next(live.current) : next
    commitCamera(live.current)
  }
  const update = (next: CameraUpdate) => {
    live.current = typeof next === 'function' ? next(live.current) : next
    draw()
    unsaved.current = live.current
    const pending = timers.current
    // Refresh culling during long gestures without rebuilding the board for every event.
    pending.cull ??= setTimeout(() => {
      pending.cull = undefined
      commitCamera(live.current)
    }, 100)
    clearTimeout(pending.rest)
    pending.rest = setTimeout(() => commitCamera(live.current), 150)
  }
  /** A step of a pan or a zoom: drawn at once, React follows. */
  const moveCamera = (next: CameraUpdate) => {
    stopFlight()
    update(next)
  }
  useLayoutEffect(draw)
  useLayoutEffect(() => {
    const el = board.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [board])
  /** Frames added out of sight, to bring into it once no gesture holds the camera */
  const unseen = useRef<string[]>([])
  /** Counts reveals begun, so only the latest (and none after the board goes) moves the camera */
  const revealing = useRef(0)
  useEffect(
    () => () => {
      flight.current?.()
      revealing.current++
      clearTimeout(timers.current.cull)
      clearTimeout(timers.current.rest)
    },
    [],
  )

  /** To `target` on a spring, turning mid-flight toward a new one at the speed it has. */
  const glideCamera = (target: BoardCamera) => {
    const from = live.current
    const moving = springs.current
    stopFlight()
    if (!from || prefersReducedMotion() || document.visibilityState === 'hidden') {
      setCamera(target)
      return
    }
    const { x, y } = moving ?? { x: new Spring(from.x), y: new Spring(from.y) }
    x.retarget(target.x)
    y.retarget(target.y)
    springs.current = { x, y }
    // Half a screen pixel, in the board's units
    const precision = 0.5 / Math.max(target.zoom, 0.01)
    flight.current = onFrames((dt) => {
      x.step(dt)
      y.step(dt)
      if (!x.atRest(precision) || !y.atRest(precision)) {
        update({ ...target, x: x.value, y: y.value })
        return false
      }
      flight.current = null
      springs.current = null
      setCamera(target)
      return true
    })
  }

  // The latest of what the camera's listeners read, without subscribing them again each render.
  const latest = useRef({ frames, sections, camera, size })
  latest.current = { frames, sections, camera: live.current, size }
  // Everything in sight, around the floating chat when it covers part of the board.
  const fit = () => {
    const el = board.current
    if (!el) return
    void clear(el, latest.current.size).then((area) => {
      const { frames, sections } = latest.current
      const areas = sections.flatMap((section) => sectionBounds(section, frames) ?? [])
      const bounds = boardBounds([...frames, ...areas])
      setCamera(fitIn(bounds && boardRectFrom(bounds), area))
    })
  }
  const zoomAt = (factor: number, at: BoardViewPoint) =>
    moveCamera((current) => current && zoomAbout(current, factor, at))
  /** Around the middle of the board, as the keys and the toolbar zoom. */
  const zoomCentred = (factor: number) => {
    const { size } = latest.current
    zoomAt(factor, boardViewPoint(size.width / 2, size.height / 2))
  }
  /** Brings a frame into sight, at the zoom there is, unless most of it shows already. */
  const reveal = (frame: Area) => {
    const { camera, size } = latest.current
    if (!camera) return
    const rect = boardRectFrom(frame)
    const view = boardViewRect(0, 0, size.width, size.height)
    if (shownShare(boardViewRectFromBoard(rect, camera), view) >= 0.5) return
    setCamera(centreIn(rect, view, camera.zoom))
  }

  // Opened without a saved camera: everything in sight, once the board has a size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit reads the latest frames itself.
  useEffect(() => {
    if (!camera && size.width) fit()
  }, [camera, size.width])

  // New frames (the agent's, or added from the menu) come into sight when they land out of
  // it, or under the floating chat. Not while a drag, resize or marquee holds the camera: the
  // frame under the pointer would slide away from it. They come into sight as it ends.
  const revealAdded = () => {
    const el = board.current
    const { size } = latest.current
    if (!unseen.current.length || !el || !live.current || !size.width) return
    if (gesture.current) return
    const token = ++revealing.current
    void clear(el, size).then((area) => {
      // A later reveal has them all, or a gesture began meanwhile (this runs again as it ends).
      if (token !== revealing.current || gesture.current) return
      const camera = live.current
      const ids = unseen.current
      unseen.current = []
      const added = latest.current.frames.filter((frame) => ids.includes(frame.id))
      if (!camera) return
      const inSight = added.some(
        (frame) => shownShare(boardViewRectFromBoard(boardRectFrom(frame), camera), area) >= 0.5,
      )
      const bounds = boardBounds(added)
      if (inSight || !bounds) return
      glideCamera(centreIn(boardRectFrom(bounds), area, camera.zoom))
    })
  }
  const known = useRef(new Set(frames.map((frame) => frame.id)))
  // Every state from main is a new object; this changes only when the layout does.
  const layout = JSON.stringify(frames.map((f) => [f.id, f.x, f.y, f.width, f.height]))
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout is the trigger; the rest is read as it is.
  useEffect(() => {
    const { frames, camera, size } = latest.current
    const added = frames.filter((frame) => !known.current.has(frame.id))
    known.current = new Set(frames.map((frame) => frame.id))
    if (!added.length || !camera || !size.width) return
    unseen.current = [...unseen.current, ...added.map((frame) => frame.id)]
    revealAdded()
  }, [layout])

  useEffect(() => {
    if (!camera) return
    unsaved.current = camera
    const timer = setTimeout(() => {
      unsaved.current = null
      sendIntent({ type: 'camera', camera, board: boardId })
    }, SAVE_CAMERA_MS)
    return () => clearTimeout(timer)
  }, [camera, boardId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as the board goes.
  useEffect(
    () => () => {
      const last = live.current ?? unsaved.current
      if (unsaved.current && last) sendIntent({ type: 'camera', camera: last, board: boardId })
    },
    [],
  )

  // The toolbar's zoom controls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoomCentred and fit read the latest state themselves.
  useEffect(() => {
    publishView({ camera, zoomBy: zoomCentred, fit })
  }, [camera])
  useEffect(() => () => publishView(null), [])

  // Scrolling pans; ⌘ or a pinch zooms around the pointer. Bound again only when the board's
  // element is (it's another before the camera is known).
  const hasCamera = camera !== null
  // biome-ignore lint/correctness/useExhaustiveDependencies: moveCamera only updates the camera.
  useEffect(() => {
    const el = board.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Mid-drag, the drag's offsets would come apart from the pointer.
      if (gesture.current) return
      const box = el.getBoundingClientRect()
      const at = boardViewPoint(event.clientX - box.left, event.clientY - box.top)
      moveCamera((current) => current && wheelBy(current, event, at))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasCamera])

  return {
    camera,
    live,
    size,
    setCamera,
    moveCamera,
    stopFlight,
    fit,
    zoomCentred,
    reveal,
    revealAdded,
  }
}

/** What the floating chat leaves clear of the board `el`, in the board's own pixels. */
async function clear(el: HTMLElement, size: { width: number; height: number }) {
  const cover = await chatCover()
  if (!cover) return clearArea(size, null)
  const box = el.getBoundingClientRect()
  return clearArea(
    size,
    boardViewRect(cover.x - box.left, cover.y - box.top, cover.width, cover.height),
  )
}
