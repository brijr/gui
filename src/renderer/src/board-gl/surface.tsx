import {
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import type { BoardCamera } from '../../../shared/board'
import { BoardRenderer } from './renderer'
import type { SceneInput } from './scene'
import { readInks } from './theme'

/*
 * The canvas the board's pixels are drawn on, and when: React says what's on the board (each
 * render), the board says the camera moved (`invalidate`), and one draw a frame at most
 * follows, only while something changed. Nothing here handles input: the board's DOM above
 * the canvas does, as it did when it drew the frames itself. Each frame's tile in that DOM
 * says which thumbnail the canvas holds for it (`data-thumb`, its width in pixels, 0 for
 * none), for tests and for anyone inspecting the board.
 */

/** A spare buffer of the canvas's is given back once nothing has been drawn for this long. */
const TRIM_AFTER_MS = 1500

export interface BoardSurfaceHandle {
  /** The camera moved, or something else the next frame should show */
  invalidate(): void
  /** The frame under the pointer, or null */
  hover(id: string | null): void
}

export type BoardSurfaceInput = Omit<SceneInput, 'hovered'> & {
  /** The Hand is on: no frame's edge lights up under the pointer */
  hand: boolean
}

export function BoardSurface({
  ref,
  input,
  camera,
  thumbs,
  tiles,
  onUnavailable,
}: {
  ref: Ref<BoardSurfaceHandle>
  input: BoardSurfaceInput
  /** The camera as it is this moment, which React's own copy follows a little behind */
  camera: () => BoardCamera | null
  /** Where thumbnails load from (`BoardState.thumbs`) */
  thumbs: string
  /** What holds the frames' tiles (`[data-frame]`), which say which thumbnail is drawn */
  tiles: RefObject<HTMLElement | null>
  /** WebGL2 couldn't start here: nothing will be drawn */
  onUnavailable: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef({
    input,
    camera,
    thumbs,
    tiles,
    onUnavailable,
    hovered: null as string | null,
    /** React has rendered since the tiles were last marked: some may be new */
    rendered: true,
  })
  const loop = useRef<{ invalidate(): void; frames(ids: ReadonlySet<string>): void } | null>(null)

  useImperativeHandle(ref, () => ({
    invalidate: () => loop.current?.invalidate(),
    hover: (id) => {
      if (latest.current.hovered === id) return
      latest.current.hovered = id
      loop.current?.invalidate()
    },
  }))

  // What's on the board changed: the next frame draws it.
  useLayoutEffect(() => {
    latest.current.input = input
    latest.current.camera = camera
    latest.current.thumbs = thumbs
    latest.current.tiles = tiles
    latest.current.onUnavailable = onUnavailable
    latest.current.rendered = true
    loop.current?.invalidate()
  })

  // Frames that left the board give up their textures.
  const ids = input.frames.map((frame) => frame.id).join('\n')
  useEffect(() => {
    loop.current?.frames(new Set(ids.split('\n')))
  }, [ids])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = () => {
      if (!frame) frame = requestAnimationFrame(() => draw())
    }
    let renderer: BoardRenderer
    try {
      renderer = new BoardRenderer(
        el,
        (want) =>
          `${latest.current.thumbs}/${want.id}${want.source === 'small' ? '.small' : ''}?v=${want.version}`,
        invalidate,
      )
    } catch {
      latest.current.onUnavailable()
      return
    }
    let marked = -1
    /** Each tile says the width of the texture its frame has now, when that may have changed. */
    const markTiles = () => {
      if (!latest.current.rendered && marked === renderer.thumbChanges) return
      latest.current.rendered = false
      marked = renderer.thumbChanges
      for (const tile of latest.current.tiles.current?.querySelectorAll<HTMLElement>(
        '[data-frame]',
      ) ?? []) {
        const width = String(renderer.thumbWidth(tile.dataset.frame ?? ''))
        if (tile.dataset.thumb !== width) tile.dataset.thumb = width
      }
    }
    let trimmer: ReturnType<typeof setTimeout> | undefined
    const draw = (trimmed = false) => {
      frame = 0
      const { input, hovered } = latest.current
      const camera = latest.current.camera()
      if (!camera) return
      const lit = hovered && !input.hand && !input.selected.has(hovered) ? hovered : null
      const again = renderer.draw({ ...input, hovered: lit }, camera, performance.now())
      markTiles()
      clearTimeout(timer)
      if (again === 0) invalidate()
      else if (again !== null) timer = setTimeout(invalidate, again)
      // Still for a while: a buffer the moving board needed goes back to the GPU.
      clearTimeout(trimmer)
      if (!trimmed)
        trimmer = setTimeout(() => {
          renderer.trim()
          cancelAnimationFrame(frame)
          draw(true)
        }, TRIM_AFTER_MS)
    }
    loop.current = { invalidate, frames: (ids) => renderer.keep(ids) }

    const theme = () => {
      renderer.setInks(readInks(el))
      invalidate()
    }
    theme()
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    scheme.addEventListener('change', theme)

    // The canvas in device pixels, exactly: its size or the display's scale changing (the
    // window dragged to another display) both arrive here. Drawn at once, in the same frame
    // the size changes: a canvas resized is a canvas cleared.
    const observer = new ResizeObserver(([entry]) => {
      const [device] = entry.devicePixelContentBoxSize
      const [css] = entry.contentBoxSize
      renderer.resize(
        { width: css.inlineSize, height: css.blockSize },
        { width: device.inlineSize, height: device.blockSize },
      )
      cancelAnimationFrame(frame)
      draw()
    })
    observer.observe(el, { box: 'device-pixel-content-box' })

    const lost = (event: Event) => {
      // Without this the context is never given back.
      event.preventDefault()
      renderer.contextLost()
      invalidate()
    }
    const restored = () => {
      renderer.contextRestored()
      invalidate()
    }
    el.addEventListener('webglcontextlost', lost)
    el.addEventListener('webglcontextrestored', restored)

    return () => {
      loop.current = null
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      clearTimeout(trimmer)
      observer.disconnect()
      scheme.removeEventListener('change', theme)
      el.removeEventListener('webglcontextlost', lost)
      el.removeEventListener('webglcontextrestored', restored)
      renderer.dispose()
    }
  }, [])

  return (
    // Nothing to a screen reader: the board's DOM over it says what's here.
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <canvas ref={canvas} className="block size-full" />
    </div>
  )
}
