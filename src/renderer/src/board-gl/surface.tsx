import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { BoardCamera } from '../../../shared/board'
import { BoardRenderer } from './renderer'
import type { SceneInput } from './scene'
import { readInks } from './theme'

/*
 * The canvas the board's pixels are drawn on, and when: React says what's on the board (each
 * render), the board says the camera moved (`invalidate`), and one draw a frame at most
 * follows, only while something changed. Nothing here handles input: the board's DOM above
 * the canvas does, as it did when it drew the frames itself.
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
}: {
  ref: Ref<BoardSurfaceHandle>
  input: BoardSurfaceInput
  /** The camera as it is this moment, which React's own copy follows a little behind */
  camera: () => BoardCamera | null
  /** Where thumbnails load from (`BoardState.thumbs`) */
  thumbs: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef({ input, camera, thumbs, hovered: null as string | null })
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
    const renderer = new BoardRenderer(
      el,
      (want) =>
        `${latest.current.thumbs}/${want.id}${want.source === 'small' ? '.small' : ''}?v=${want.version}`,
      invalidate,
    )
    let trimmer: ReturnType<typeof setTimeout> | undefined
    const draw = (trimmed = false) => {
      frame = 0
      const { input, hovered } = latest.current
      const camera = latest.current.camera()
      if (!camera) return
      const lit = hovered && !input.hand && !input.selected.has(hovered) ? hovered : null
      const again = renderer.draw({ ...input, hovered: lit }, camera, performance.now())
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
