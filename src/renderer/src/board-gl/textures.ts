import type { ThumbWant } from './scene'

/*
 * Frames' thumbnails as textures: one a frame, at the width it's drawn (`thumbTier`). A
 * thumbnail is fetched and decoded off the main thread (`createImageBitmap` on the fetched
 * bytes, resized there to the width wanted), uploaded within a few milliseconds a frame, and
 * its bitmap freed at once. A texture is replaced when the frame wants another width (zoomed
 * in or out) or a newer capture, and stays drawn until the new one is in: never blank between.
 * Textures of frames out of view stay while there's room (`budget`), the longest unseen going
 * first. A lost GPU context loses them all; they load again as frames are drawn.
 */

/** A texture with its mip levels takes a third again. */
const MIPS = 4 / 3
/**
 * Textures wider than this get mip levels, for the moments a pinch draws one far smaller than
 * it is, before the zoom rests and a smaller one replaces it. Narrower ones go without: each
 * level is an allocation of its own, and at this size they cost more than the texture
 * (measured: 360 textures 180 wide took 89 MB of GPU memory with levels, 37 MB by their pixels).
 */
const MIPS_ABOVE = 360
/** Thumbnails fetched and decoded at once. */
const LOADS = 8
/** Uploads stop for this frame once they've taken this long; the rest go in the next. */
const UPLOAD_BUDGET_MS = 4

interface Entry {
  id: string
  texture: WebGLTexture | null
  /** The texture's own size, in pixels */
  width: number
  height: number
  bytes: number
  /** What the texture was made for: `ThumbWant.width` and `version` */
  made: string
  /** The draw it was last used in */
  used: number
  want: ThumbWant | null
  loading: { key: string; abort: AbortController } | null
  ready: { key: string; bitmap: ImageBitmap } | null
  /** The want that couldn't be loaded: not tried again until it changes */
  failed: string
}

const keyOf = (want: ThumbWant) => `${want.width}@${want.version}`

export class ThumbTextures {
  /** Bytes of texture kept before those out of view are freed */
  budget = 96 * 1048576
  private entries = new Map<string, Entry>()
  private seen: Entry[] = []
  /** Frames in the last draw that want a texture loaded, in the order they're drawn */
  private queue: Entry[] = []
  /** Entries whose bitmap is decoded and waits for the next draw to be uploaded */
  private decoded = new Set<Entry>()
  private bytes = 0
  private draws = 0
  private active = 0
  private disposed = false

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly url: (want: ThumbWant) => string,
    /** A thumbnail is decoded, or a load ended: there's something to draw or to start */
    private readonly changed: () => void,
  ) {}

  /** The texture to draw for a frame now, if it has one; and notes the one it wants. */
  use(want: ThumbWant) {
    let entry = this.entries.get(want.id)
    if (!entry) {
      entry = {
        id: want.id,
        texture: null,
        width: 0,
        height: 0,
        bytes: 0,
        made: '',
        used: 0,
        want: null,
        loading: null,
        ready: null,
        failed: '',
      }
      this.entries.set(want.id, entry)
    }
    entry.want = want
    entry.used = this.draws
    this.seen.push(entry)
    return entry.texture ? entry : null
  }

  /**
   * After a draw: uploads what's decoded, queues what the frames just drawn want, and frees
   * what's over budget. `rest` is how long until the zoom has held still (0 once it has): a
   * frame that has a texture keeps it until then, since a pinch passes through widths it
   * never rests at; one with nothing to show loads at once. Returns how soon to draw again,
   * in ms: 0 when a new texture is in, `rest` while one waits on it, null for nothing.
   */
  settle(rest: number): number | null {
    let again: number | null = null
    const started = performance.now()
    for (const entry of this.decoded) {
      // Decoded for a frame that has since left the view: its bitmap goes, unused.
      if (entry.used !== this.draws) {
        entry.ready?.bitmap.close()
        entry.ready = null
        this.decoded.delete(entry)
        continue
      }
      again = 0
      if (performance.now() - started > UPLOAD_BUDGET_MS) break
      this.upload(entry)
      this.decoded.delete(entry)
    }

    this.queue.length = 0
    for (const entry of this.seen) {
      if (!this.needs(entry)) continue
      if (entry.texture && rest > 0) again = again === null ? rest : Math.min(again, rest)
      else this.queue.push(entry)
    }
    this.pump()

    if (this.bytes > this.budget) {
      const idle = [...this.entries.values()]
        .filter((entry) => entry.texture && entry.used < this.draws)
        .sort((a, b) => a.used - b.used)
      for (const entry of idle) {
        if (this.bytes <= this.budget) break
        this.free(entry)
      }
    }
    this.seen.length = 0
    this.draws++
    return again
  }

  /** Whether a frame wants a texture it neither has nor is on its way to having. */
  private needs(entry: Entry) {
    if (!entry.want) return false
    const key = keyOf(entry.want)
    return (
      entry.made !== key &&
      entry.ready?.key !== key &&
      entry.failed !== key &&
      entry.loading?.key !== key
    )
  }

  /** Starts as many queued loads as there's room for; each that ends starts the next. */
  private pump() {
    while (this.active < LOADS) {
      const entry = this.queue.shift()
      if (!entry) return
      if (!entry.want || !this.needs(entry)) continue
      // What it was loading is no longer what it wants.
      entry.loading?.abort.abort()
      entry.loading = null
      void this.load(entry, entry.want)
    }
  }

  private async load(entry: Entry, want: ThumbWant) {
    const key = keyOf(want)
    const abort = new AbortController()
    entry.loading = { key, abort }
    this.active++
    try {
      const response = await fetch(this.url(want), { signal: abort.signal })
      if (!response.ok) throw new Error(`No thumbnail (${response.status})`)
      const blob = await response.blob()
      const bitmap = await createImageBitmap(
        blob,
        want.width < want.sourceWidth ? { resizeWidth: want.width, resizeQuality: 'high' } : {},
      )
      if (abort.signal.aborted || this.disposed) bitmap.close()
      else {
        entry.ready?.bitmap.close()
        entry.ready = { key, bitmap }
        this.decoded.add(entry)
      }
    } catch {
      if (!abort.signal.aborted) entry.failed = key
    } finally {
      this.active--
      if (entry.loading?.abort === abort) entry.loading = null
      if (!this.disposed) {
        this.pump()
        this.changed()
      }
    }
  }

  private upload(entry: Entry) {
    const ready = entry.ready
    if (!ready) return
    entry.ready = null
    const { gl } = this
    const { bitmap } = ready
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    const levels = bitmap.width > MIPS_ABOVE
    if (levels) gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      levels ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.free(entry)
    entry.texture = texture
    entry.width = bitmap.width
    entry.height = bitmap.height
    entry.bytes = bitmap.width * bitmap.height * 4 * (levels ? MIPS : 1)
    entry.made = ready.key
    this.bytes += entry.bytes
    bitmap.close()
  }

  private free(entry: Entry) {
    if (!entry.texture) return
    this.gl.deleteTexture(entry.texture)
    this.bytes -= entry.bytes
    entry.texture = null
    entry.bytes = 0
    entry.made = ''
  }

  /** Frames that left the board give up their textures. */
  keep(ids: ReadonlySet<string>) {
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) continue
      this.drop(entry)
      this.entries.delete(id)
    }
  }

  private drop(entry: Entry) {
    entry.loading?.abort.abort()
    entry.loading = null
    entry.ready?.bitmap.close()
    entry.ready = null
    this.decoded.delete(entry)
    this.free(entry)
  }

  /** The GPU context went, and its textures with it: each loads again as it's next drawn. */
  lost() {
    for (const entry of this.entries.values()) {
      entry.loading?.abort.abort()
      entry.loading = null
      entry.ready?.bitmap.close()
      entry.ready = null
      entry.texture = null
      entry.bytes = 0
      entry.made = ''
    }
    this.decoded.clear()
    this.queue.length = 0
    this.bytes = 0
  }

  dispose() {
    this.disposed = true
    for (const entry of this.entries.values()) this.drop(entry)
    this.entries.clear()
    this.queue.length = 0
  }
}
