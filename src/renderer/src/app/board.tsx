import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type BoardCamera,
  boardBounds,
  clampZoom,
  FRAME_MAX,
  FRAME_MIN,
  fitCamera,
} from '../../../shared/board'
import type { BoardFrame, BoardState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Card, GroupLabel } from '../lib/surface'
import { Button } from '../lib/ui'

/** The frame label's height above a frame, in screen pixels. */
const LABEL_HEIGHT = 22
/** The dot grid's spacing at 100%, in board pixels. */
const GRID = 24
/** A press that moves less than this (screen pixels) is a click, not a drag. */
const DRAG_SLOP = 3
/** The resize handle's size, in screen pixels. */
const HANDLE = 10
/** Each ⌘+ or ⌘− step. */
const ZOOM_STEP = 1.25
/** Two clicks on a frame this close together open it. */
const DOUBLE_CLICK_MS = 400
/** Where the camera rests, saved this long after the last pan or zoom. */
const SAVE_CAMERA_MS = 400

/** Prompts for an empty canvas: the kinds of thing a board is good for. */
const STARTERS = [
  'A landing page for a neighborhood coffee roaster',
  'Three different pricing page options, side by side',
  'A mobile onboarding flow in three screens',
  'A dashboard for a small fitness studio',
]

interface Size {
  width: number
  height: number
}

// The board's camera, shared with the toolbar's zoom controls (`useBoardView`).
interface BoardView {
  camera: BoardCamera | null
  zoomBy: (factor: number) => void
  fit: () => void
}

let view: BoardView = { camera: null, zoomBy: () => undefined, fit: () => undefined }
const viewListeners = new Set<() => void>()

function publishView(next: BoardView) {
  view = next
  for (const listener of viewListeners) listener()
}

/** The board's zoom and its controls, for the toolbar. */
export function useBoardView() {
  return useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener)
      return () => {
        viewListeners.delete(listener)
      }
    },
    () => view,
  )
}

/** A frame moved or resized on the board before main has it, as it's drawn meanwhile. */
type Override = Pick<BoardFrame, 'x' | 'y' | 'width' | 'height'>

type Gesture =
  | {
      kind: 'move'
      start: { x: number; y: number }
      ids: string[]
      moved: boolean
      /** The press was on a frame already selected, with ⇧: a click deselects it */
      toggle: string | null
    }
  | { kind: 'resize'; start: { x: number; y: number }; id: string; from: Override }
  | { kind: 'pan'; start: { x: number; y: number }; from: BoardCamera }
  | {
      kind: 'marquee'
      start: { x: number; y: number }
      now: { x: number; y: number }
      add: string[]
    }

/**
 * A canvas's frames on a pannable, zoomable board, like Figma's: their thumbnails (main
 * captures them as their pages change), their names above them, and what's selected. Scroll
 * pans, ⌘-scroll or a pinch zooms, Space-drag pans; drag frames to move them, their corner to
 * resize them, across empty board to select several; double-click opens one live.
 */
export function Board({ board }: { board: BoardState }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [camera, setCamera] = useState<BoardCamera | null>(board.camera)
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [space, setSpace] = useState(false)
  const frames = board.frames.map((frame) => ({ ...frame, ...overrides[frame.id] }))
  const selected = new Set(board.selection)
  /** The last click on a frame, to tell a double-click (the pointer is captured, so no dblclick) */
  const lastClick = useRef<{ id: string; at: number } | null>(null)
  // Every state from main is a new object; this changes only when the layout does.
  const layout = JSON.stringify(board.frames.map((f) => [f.id, f.x, f.y, f.width, f.height]))

  // What main has now replaces what was drawn ahead of it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new layout from main is the trigger.
  useEffect(() => setOverrides({}), [layout])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  // The latest of what the board's listeners read, without subscribing them again each render.
  const latest = useRef({ frames: board.frames, camera, size })
  latest.current = { frames: board.frames, camera, size }
  const fit = () => {
    const { frames, size } = latest.current
    setCamera(fitCamera(boardBounds(frames), size))
  }
  const zoomAt = (factor: number, at: { x: number; y: number }) =>
    setCamera((current) => {
      if (!current) return current
      const zoom = clampZoom(current.zoom * factor)
      // The board point under `at` stays under it.
      return {
        zoom,
        x: current.x + at.x / current.zoom - at.x / zoom,
        y: current.y + at.y / current.zoom - at.y / zoom,
      }
    })

  // Opened without a saved camera: everything in sight, once the board has a size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit reads the latest frames itself.
  useEffect(() => {
    if (!camera && size.width) fit()
  }, [camera, size.width])

  // The agent's new frames come into sight when they land off screen.
  const known = useRef(new Set(board.frames.map((frame) => frame.id)))
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout is the trigger; the rest is read as it is.
  useEffect(() => {
    const { frames, camera, size } = latest.current
    const added = frames.filter((frame) => !known.current.has(frame.id))
    known.current = new Set(frames.map((frame) => frame.id))
    if (!added.length || !camera || !size.width) return
    const visible = added.some((frame) => {
      const left = (frame.x - camera.x) * camera.zoom
      const top = (frame.y - camera.y) * camera.zoom
      return left < size.width && top < size.height && left + frame.width * camera.zoom > 0
    })
    const area = boardBounds(added)
    if (visible || !area) return
    setCamera({
      ...camera,
      x: area.x + area.width / 2 - size.width / 2 / camera.zoom,
      y: area.y + area.height / 2 - size.height / 2 / camera.zoom,
    })
  }, [layout])

  // Saved once it rests, for the next time the canvas opens.
  useEffect(() => {
    if (!camera) return
    const timer = setTimeout(() => gui.boardCamera(camera), SAVE_CAMERA_MS)
    return () => clearTimeout(timer)
  }, [camera])

  // The toolbar's zoom controls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoomAt and fit read the latest state themselves.
  useEffect(() => {
    publishView({
      camera,
      zoomBy: (factor) => {
        const { size } = latest.current
        zoomAt(factor, { x: size.width / 2, y: size.height / 2 })
      },
      fit,
    })
  }, [camera])
  useEffect(
    () => () => publishView({ camera: null, zoomBy: () => undefined, fit: () => undefined }),
    [],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: fit reads the latest frames itself.
  useEffect(
    () =>
      gui.onBoardCommand((command) => {
        if (command.type === 'renameFrame') setRenaming(command.id)
        else if (command.type === 'fit' || (command.type === 'zoom' && command.step === 0)) fit()
        else if (command.type === 'zoom') {
          const { size } = latest.current
          zoomAt(command.step === 1 ? ZOOM_STEP : 1 / ZOOM_STEP, {
            x: size.width / 2,
            y: size.height / 2,
          })
        }
      }),
    [],
  )

  // Scrolling pans; ⌘ or a pinch (which arrives as ⌃-wheel) zooms around the pointer.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = el.getBoundingClientRect()
      const at = { x: event.clientX - box.left, y: event.clientY - box.top }
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), at)
        return
      }
      setCamera((current) =>
        current
          ? {
              ...current,
              x: current.x + event.deltaX / current.zoom,
              y: current.y + event.deltaY / current.zoom,
            }
          : current,
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // Space held: dragging pans, as in every design tool.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isTyping(event.target)) {
        event.preventDefault()
        setSpace(true)
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  if (!camera) return <div ref={ref} className="absolute inset-0" />

  const toScreen = (frame: Override) => ({
    left: (frame.x - camera.x) * camera.zoom,
    top: (frame.y - camera.y) * camera.zoom,
    width: frame.width * camera.zoom,
    height: frame.height * camera.zoom,
  })
  const local = (event: { clientX: number; clientY: number }) => {
    const box = ref.current?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button === 2) return
    ref.current?.focus({ preventScroll: true })
    const at = local(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (space || event.button === 1) {
      setGesture({ kind: 'pan', start: at, from: camera })
      return
    }
    const target = event.target as HTMLElement
    const handle = target.closest<HTMLElement>('[data-resize]')?.dataset.resize
    const frameId = target.closest<HTMLElement>('[data-frame]')?.dataset.frame
    if (handle) {
      const frame = frames.find((f) => f.id === handle)
      if (frame) setGesture({ kind: 'resize', start: at, id: handle, from: frame })
      return
    }
    if (frameId) {
      let ids = board.selection
      let toggle: string | null = null
      if (event.shiftKey) {
        if (selected.has(frameId)) toggle = frameId
        else ids = [...ids, frameId]
      } else if (!selected.has(frameId)) ids = [frameId]
      if (ids !== board.selection) gui.boardSelect(ids)
      setGesture({ kind: 'move', start: at, ids, moved: false, toggle })
      return
    }
    setGesture({ kind: 'marquee', start: at, now: at, add: event.shiftKey ? board.selection : [] })
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!gesture) return
    const at = local(event)
    const dx = (at.x - gesture.start.x) / camera.zoom
    const dy = (at.y - gesture.start.y) / camera.zoom
    if (gesture.kind === 'pan') {
      setCamera({ ...gesture.from, x: gesture.from.x - dx, y: gesture.from.y - dy })
    } else if (gesture.kind === 'move') {
      const far = Math.hypot(at.x - gesture.start.x, at.y - gesture.start.y) > DRAG_SLOP
      if (!gesture.moved && !far) return
      if (!gesture.moved) setGesture({ ...gesture, moved: true })
      const next: Record<string, Override> = {}
      for (const frame of board.frames) {
        if (!gesture.ids.includes(frame.id)) continue
        next[frame.id] = { ...frame, x: Math.round(frame.x + dx), y: Math.round(frame.y + dy) }
      }
      setOverrides(next)
    } else if (gesture.kind === 'resize') {
      const edge = (value: number) => Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, value)))
      setOverrides({
        [gesture.id]: {
          ...gesture.from,
          width: edge(gesture.from.width + dx),
          height: edge(gesture.from.height + dy),
        },
      })
    } else {
      setGesture({ ...gesture, now: at })
    }
  }

  const onPointerUp = () => {
    const done = gesture
    setGesture(null)
    if (!done) return
    if (done.kind === 'move') {
      if (done.moved) {
        gui.boardArrange(
          Object.entries(overrides).map(([id, frame]) => ({ id, x: frame.x, y: frame.y })),
        )
      } else if (done.toggle) {
        gui.boardSelect(board.selection.filter((id) => id !== done.toggle))
      } else if (done.ids.length) {
        // A second click on the same frame soon after: open it.
        const id = done.ids.at(-1) ?? ''
        const now = performance.now()
        const last = lastClick.current
        lastClick.current = { id, at: now }
        if (last?.id === id && now - last.at < DOUBLE_CLICK_MS) {
          lastClick.current = null
          gui.boardOpenFrame(id)
        }
      }
    } else if (done.kind === 'resize') {
      const frame = overrides[done.id]
      if (frame) gui.boardArrange([{ id: done.id, ...frame }])
    } else if (done.kind === 'marquee') {
      const box = marqueeBox(done.start, done.now)
      if (box.width < DRAG_SLOP && box.height < DRAG_SLOP) {
        if (board.selection.length && !done.add.length) gui.boardSelect([])
        return
      }
      const hit = frames
        .filter((frame) => intersects(toScreen(frame), box))
        .map((frame) => frame.id)
      gui.boardSelect([...done.add, ...hit.filter((id) => !done.add.includes(id))])
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isTyping(event.target)) return
    const command = event.metaKey || event.ctrlKey
    const ids = board.selection
    const nudge = event.shiftKey ? 10 : 1
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-nudge, 0],
      ArrowRight: [nudge, 0],
      ArrowUp: [0, -nudge],
      ArrowDown: [0, nudge],
    }
    let handled = true
    if ((event.key === 'Backspace' || event.key === 'Delete') && ids.length) gui.boardDelete(ids)
    else if (command && event.key === 'd' && ids.length) gui.boardDuplicate(ids)
    else if (command && event.key === 'a') gui.boardSelect(board.frames.map((frame) => frame.id))
    else if (command && event.key === '0') fit()
    else if (command && (event.key === '=' || event.key === '+'))
      zoomAt(ZOOM_STEP, { x: size.width / 2, y: size.height / 2 })
    else if (command && event.key === '-')
      zoomAt(1 / ZOOM_STEP, { x: size.width / 2, y: size.height / 2 })
    else if (event.key === 'Enter' && ids.length === 1) gui.boardOpenFrame(ids[0])
    else if (event.key === 'Escape' && ids.length) gui.boardSelect([])
    else if (arrows[event.key] && ids.length && !command) {
      const [dx, dy] = arrows[event.key]
      gui.boardArrange(
        board.frames
          .filter((frame) => ids.includes(frame.id))
          .map((frame) => ({ id: frame.id, x: frame.x + dx, y: frame.y + dy })),
      )
    } else handled = false
    if (handled) event.preventDefault()
  }

  const grid = GRID * camera.zoom
  const marquee = gesture?.kind === 'marquee' ? marqueeBox(gesture.start, gesture.now) : null
  const single = board.selection.length === 1 ? board.selection[0] : null

  return (
    // The board is one control: it takes the keyboard when pressed, and names what's selected.
    <div
      ref={ref}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" handles its own keys.
      tabIndex={0}
      role="application"
      aria-label={`Canvas ${board.name}, ${board.frames.length} frames`}
      className={cn(
        'absolute inset-0 overflow-hidden bg-canvas outline-none select-none',
        space && (gesture?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      style={{
        backgroundImage:
          grid >= 8 ? 'radial-gradient(var(--line-strong) 1px, transparent 1px)' : undefined,
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        const id = (event.target as HTMLElement).closest<HTMLElement>('[data-frame]')?.dataset.frame
        if (!id) return
        event.preventDefault()
        gui.showFrameMenu(id)
      }}
    >
      {frames.map((frame) => {
        const box = toScreen(frame)
        if (
          box.left > size.width ||
          box.top - LABEL_HEIGHT > size.height ||
          box.left + box.width < 0 ||
          box.top + box.height < 0
        )
          return null
        const isSelected = selected.has(frame.id)
        return (
          <div key={frame.id}>
            <FrameLabel
              frame={frame}
              box={box}
              selected={isSelected}
              renaming={renaming === frame.id}
              onSelect={(add) => {
                if (!add) gui.boardSelect([frame.id])
                else if (!isSelected) gui.boardSelect([...board.selection, frame.id])
              }}
              onRename={() => setRenaming(frame.id)}
              onDone={(name) => {
                setRenaming(null)
                if (name && name !== frame.name) gui.boardRenameFrame(frame.id, name)
              }}
            />
            <div
              data-frame={frame.id}
              className={cn(
                'absolute overflow-hidden bg-raised shadow-raised',
                isSelected
                  ? 'outline-2 outline-accent'
                  : 'outline-1 -outline-offset-1 outline-line hover:outline-accent',
              )}
              style={box}
            >
              {frame.captured ? (
                <img
                  src={`${board.thumbs}/${frame.id}?v=${frame.version}`}
                  alt=""
                  draggable={false}
                  className="pointer-events-none block w-full object-cover object-top"
                  style={{ height: '100%' }}
                />
              ) : (
                <div className="flex h-full items-start p-3 text-caption text-subtle">
                  Rendering…
                </div>
              )}
            </div>
            {single === frame.id && (
              <div
                data-resize={frame.id}
                aria-hidden="true"
                className="absolute cursor-nwse-resize rounded-sm border-2 border-accent bg-raised"
                style={{
                  left: box.left + box.width - HANDLE / 2,
                  top: box.top + box.height - HANDLE / 2,
                  width: HANDLE,
                  height: HANDLE,
                }}
              />
            )}
          </div>
        )
      })}

      {marquee && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute border border-accent bg-accent-soft"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}

      {!board.frames.length && <EmptyBoard />}
    </div>
  )
}

/** A frame's name above it, and its size; double-click renames it in place. */
function FrameLabel({
  frame,
  box,
  selected,
  renaming,
  onSelect,
  onRename,
  onDone,
}: {
  frame: BoardFrame
  box: { left: number; top: number; width: number }
  selected: boolean
  renaming: boolean
  onSelect: (add: boolean) => void
  onRename: () => void
  onDone: (name: string | null) => void
}) {
  const style = {
    left: box.left,
    top: box.top - LABEL_HEIGHT,
    height: LABEL_HEIGHT,
    maxWidth: Math.max(box.width, 120),
  }
  if (renaming)
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
        autoFocus
        aria-label="Frame name"
        defaultValue={frame.name}
        className="absolute rounded-sm border border-accent bg-raised px-1 text-caption text-fg outline-none"
        style={{ ...style, width: Math.max(box.width, 160) }}
        onFocus={(event) => event.currentTarget.select()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') onDone(event.currentTarget.value.trim() || null)
          if (event.key === 'Escape') onDone(null)
        }}
        onBlur={(event) => onDone(event.currentTarget.value.trim() || null)}
      />
    )
  return (
    <p
      data-frame={frame.id}
      className={cn(
        'absolute flex items-center gap-1.5 truncate text-caption whitespace-nowrap',
        selected ? 'text-accent-text' : 'text-muted',
      )}
      style={style}
      // Its own clicks: a press selects the frame (no drag from here), a double-click renames.
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        onSelect(event.shiftKey)
      }}
      onDoubleClick={onRename}
    >
      <span className="truncate font-medium">{frame.name}</span>
      <span className="shrink-0 text-subtle tabular-nums">
        {frame.width} × {frame.height}
      </span>
    </p>
  )
}

/** An empty canvas: what to ask for, rather than a blank void. */
function EmptyBoard() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
      <Card
        className="pointer-events-auto flex w-full max-w-md flex-col gap-4 p-5"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">Start your canvas</h2>
          <p className="text-pretty text-muted">
            Ask your agent for a page or a few versions of one. Each lands here as a frame you can
            move, compare and open.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <GroupLabel>Try</GroupLabel>
          <div className="flex flex-col items-start gap-1.5">
            {STARTERS.map((prompt) => (
              <Button
                key={prompt}
                size="sm"
                className="h-auto max-w-full justify-start py-1.5 text-left whitespace-normal"
                onClick={() => void gui.send(prompt)}
              >
                {prompt}
              </Button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}

function marqueeBox(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

function intersects(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
) {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  )
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
