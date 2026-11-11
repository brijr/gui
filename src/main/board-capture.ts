import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import {
  type BoardFrameLayout,
  FRAME_MAX,
  FRAMES_DIR,
  SMALL_THUMB_WIDTH,
  THUMB_DENSITY,
  THUMB_WIDTH,
} from '../shared/board'
import { writeFileAtomic } from './atomic-file'
import { boardAssetSignature, pageSignature } from './board-assets'
import {
  type BoardCaptureQueue,
  boardCaptureQueue,
  CAPTURE_PRIORITY,
  type CaptureJob,
} from './board-capture-queue'

/** How much of a tall frame its thumbnail shows; screenshots and exports show all of it. */
const THUMB_MAX_HEIGHT = 3000

/**
 * A frame's page stopped responding while it was rendered (most likely a script that never
 * ends), so it was stopped rather than left holding the capture queue.
 */
export class UnresponsiveFrameError extends Error {
  constructor(id: string) {
    super(
      `Frame ${id}'s page didn't respond, so it was stopped: most likely a script on it never finishes (an infinite loop). Fix its script, then try again.`,
    )
    this.name = 'UnresponsiveFrameError'
  }
}

export interface BoardCaptureRenderer {
  /**
   * The frame's page, its top `maxHeight` CSS pixels at most; null when it couldn't be
   * rendered, and UnresponsiveFrameError when the page hung and was stopped.
   */
  render(
    frame: BoardFrameLayout,
    url: string,
    scale: number,
    signal: AbortSignal,
    maxHeight: number,
  ): Promise<NativeImage | null>
  dispose(): void
}

interface CaptureHost {
  root: string
  thumbs: string
  frames(): readonly BoardFrameLayout[]
  frame(id: string): BoardFrameLayout | null
  url(id: string): string
  changed(id: string): void
}

interface CachedThumbnail {
  assets: string
  page: string
  width: number
  height: number
  /** THUMB_WIDTH when it was made; thumbnails from a smaller limit are made again */
  thumbWidth?: number
  /** SMALL_THUMB_WIDTH when it was made; without a small copy, it's made again */
  smallWidth?: number
  /** THUMB_DENSITY when it was made; one captured at 1× is made again */
  density?: number
}

interface ThumbnailRequest {
  job: CaptureJob<void>
  started: boolean
}

/** Owns capture lifetime, prioritization, and freshness, independently of board mutations. */
export class BoardCaptures {
  private assets = ''
  private cache: Record<string, CachedThumbnail> = {}
  private captured = new Set<string>()
  /**
   * Each thumbnail's version, in its URL. They start from when this opening began, so a URL
   * never repeats across openings and the board never shows an image it cached before.
   */
  private readonly firstVersion = Date.now()
  private versions = new Map<string, number>()
  /** Frames whose page hung, by the assets and page they hung with: not tried again until one changes */
  private hung = new Map<string, string>()
  /** Thumbnails being deleted, so a new capture of the same frame lands after */
  private removing = new Map<string, Promise<void>>()
  private revisions = new Map<string, number>()
  private thumbnails = new Map<string, ThumbnailRequest>()
  private jobs = new Set<CaptureJob<unknown>>()
  private visible = new Set<string>()
  private disposed = false
  private completion: Promise<void> | null = null

  constructor(
    private readonly host: CaptureHost,
    private readonly renderer: BoardCaptureRenderer,
    private readonly queue: BoardCaptureQueue = boardCaptureQueue,
  ) {}

  private get cachePath() {
    return join(this.host.thumbs, 'cache.json')
  }

  path(id: string) {
    return join(this.host.thumbs, `${id}.jpg`)
  }

  /** The copy the board shows zoomed out, SMALL_THUMB_WIDTH wide. */
  private smallPath(id: string) {
    return join(this.host.thumbs, `${id}.small.jpg`)
  }

  status(id: string) {
    return { version: this.versions.get(id) ?? this.firstVersion, captured: this.captured.has(id) }
  }

  async open() {
    const [assets, text] = await Promise.all([
      boardAssetSignature(this.host.root),
      readFile(this.cachePath, 'utf8').catch(() => null),
    ])
    if (this.disposed) return
    this.assets = assets
    try {
      const parsed: unknown = JSON.parse(text ?? '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        this.cache = parsed as Record<string, CachedThumbnail>
    } catch {
      // Missing or damaged cache metadata only means recapturing thumbnails.
    }
    await this.sweep()
    if (this.disposed) return
    await Promise.all(
      this.host.frames().map(async (frame) => {
        const [page, thumb, small] = await Promise.all([
          pageSignature(join(this.host.root, FRAMES_DIR, `${frame.id}.html`)),
          stat(this.path(frame.id)).catch(() => null),
          stat(this.smallPath(frame.id)).catch(() => null),
        ])
        if (this.disposed) return
        if (thumb) this.captured.add(frame.id)
        const cached = this.cache[frame.id]
        if (
          !thumb ||
          !small ||
          !page ||
          cached?.assets !== assets ||
          cached.page !== page ||
          cached.width !== frame.width ||
          cached.height !== frame.height ||
          cached.thumbWidth !== THUMB_WIDTH ||
          cached.smallWidth !== SMALL_THUMB_WIDTH ||
          cached.density !== THUMB_DENSITY
        )
          void this.thumbnail(frame.id)
      }),
    )
  }

  /** Thumbnails of frames no longer on the board (deleted while it was closed), and temp files. */
  private async sweep() {
    const frames = new Set(this.host.frames().map((frame) => frame.id))
    const files = await readdir(this.host.thumbs).catch(() => [] as string[])
    const owner = (file: string) => file.replace(/(\.small)?\.jpg$/, '')
    await Promise.all(
      files
        .filter(
          (file) => file.endsWith('.tmp') || (file.endsWith('.jpg') && !frames.has(owner(file))),
        )
        .map((file) => rm(join(this.host.thumbs, file), { force: true }).catch(() => undefined)),
    )
  }

  prioritize(ids: readonly string[]) {
    this.visible = new Set(ids)
    for (const id of ids) this.thumbnails.get(id)?.job.promote(CAPTURE_PRIORITY.visible)
  }

  /** Coalesce waiting work, but invalidate an active render and queue its replacement. */
  thumbnail(id: string, interactive = false): Promise<void> {
    if (this.disposed || !this.host.frame(id)) return Promise.resolve()
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    const priority = interactive
      ? CAPTURE_PRIORITY.interactive
      : this.visible.has(id)
        ? CAPTURE_PRIORITY.visible
        : CAPTURE_PRIORITY.background
    const existing = this.thumbnails.get(id)
    if (existing && !existing.started) {
      existing.job.promote(priority)
      return existing.job.done.catch(() => undefined).then(() => undefined)
    }
    const request: ThumbnailRequest = {
      started: false,
      job: this.queue.schedule(priority, async (signal) => {
        request.started = true
        await this.capture(id, signal)
      }),
    }
    this.thumbnails.set(id, request)
    this.track(request.job)
    return request.job.done
      .catch((error: unknown) => console.error(`[gui] could not capture frame ${id}`, error))
      .finally(() => {
        if (this.thumbnails.get(id) === request) this.thumbnails.delete(id)
      })
      .then(() => undefined)
  }

  async invalidateAssets(): Promise<boolean> {
    const next = await boardAssetSignature(this.host.root)
    if (this.disposed || next === this.assets) return false
    this.assets = next
    for (const frame of this.host.frames()) void this.thumbnail(frame.id)
    return true
  }

  /** The frame left the board: its capture stops and its thumbnail is deleted. */
  forget(id: string): Promise<void> {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.thumbnails.get(id)?.job.cancel()
    this.thumbnails.delete(id)
    this.captured.delete(id)
    this.hung.delete(id)
    delete this.cache[id]
    const removal = Promise.all([
      rm(this.path(id), { force: true }),
      rm(this.smallPath(id), { force: true }),
    ]).then(
      () => undefined,
      () => undefined,
    )
    this.removing.set(id, removal)
    void removal.then(() => {
      if (this.removing.get(id) === removal) this.removing.delete(id)
    })
    return removal
  }

  async screenshot(id: string, scale = 1): Promise<NativeImage> {
    if (this.disposed) throw new Error('Canvas closed')
    const job = this.queue.schedule(CAPTURE_PRIORITY.interactive, async (signal) => {
      const frame = this.host.frame(id)
      return frame ? this.renderer.render(frame, this.host.url(id), scale, signal, FRAME_MAX) : null
    })
    this.track(job)
    const image = await job.done
    if (!image) throw new Error(`Couldn't render frame ${id}.`)
    return image
  }

  private track(job: CaptureJob<unknown>) {
    this.jobs.add(job)
    // Do not create an unhandled rejection from a bookkeeping-only finally callback.
    void job.done.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    )
  }

  private async capture(id: string, signal: AbortSignal) {
    const frame = this.host.frame(id)
    if (!frame || this.disposed || signal.aborted) return
    const revision = this.revisions.get(id)
    const assets = this.assets
    const page = await pageSignature(join(this.host.root, FRAMES_DIR, `${id}.html`))
    if (!page || this.disposed || signal.aborted) return
    // A page that hung would hold the queue again for nothing; it's tried once it changes.
    const attempt = `${assets}\n${page}`
    if (this.hung.get(id) === attempt) return
    const current = () =>
      !this.disposed &&
      !signal.aborted &&
      this.host.frame(id) !== null &&
      this.revisions.get(id) === revision &&
      this.assets === assets
    let image: NativeImage | null
    try {
      // Narrower than THUMB_WIDTH, it's captured at 2× and narrowed to THUMB_WIDTH at most
      // (`thumbWidthOf`): two worker scales, not one for every width.
      const scale = frame.width < THUMB_WIDTH ? THUMB_DENSITY : 1
      image = await this.renderer.render(frame, this.host.url(id), scale, signal, THUMB_MAX_HEIGHT)
    } catch (error) {
      if (!(error instanceof UnresponsiveFrameError)) throw error
      this.hung.set(id, attempt)
      console.warn(`[gui] frame ${id} stopped responding while its thumbnail was made`)
      return
    }
    if (!image || !current()) return
    if (page !== (await pageSignature(join(this.host.root, FRAMES_DIR, `${id}.html`)))) {
      void this.thumbnail(id)
      return
    }
    const narrow = (width: number) =>
      image.getSize().width > width ? image.resize({ width, quality: 'good' }) : image
    await this.removing.get(id)
    if (!current()) return
    await mkdir(this.host.thumbs, { recursive: true })
    const suffix = `${randomBytes(6).toString('hex')}.tmp`
    const temp = `${this.path(id)}.${suffix}`
    const smallTemp = `${this.smallPath(id)}.${suffix}`
    try {
      await Promise.all([
        writeFile(temp, narrow(THUMB_WIDTH).toJPEG(82)),
        writeFile(smallTemp, narrow(SMALL_THUMB_WIDTH).toJPEG(82)),
      ])
      if (!current()) return
      await rename(smallTemp, this.smallPath(id))
      await rename(temp, this.path(id))
      if (!current()) return
      this.cache[id] = {
        assets,
        page,
        width: frame.width,
        height: frame.height,
        thumbWidth: THUMB_WIDTH,
        smallWidth: SMALL_THUMB_WIDTH,
        density: THUMB_DENSITY,
      }
      await writeFileAtomic(this.cachePath, JSON.stringify(this.cache))
      if (!current()) return
      this.captured.add(id)
      this.versions.set(id, (this.versions.get(id) ?? this.firstVersion) + 1)
      this.host.changed(id)
    } finally {
      await Promise.all([rm(temp, { force: true }), rm(smallTemp, { force: true })]).catch(
        () => undefined,
      )
    }
  }

  dispose(): Promise<void> {
    if (this.completion) return this.completion
    this.disposed = true
    for (const job of this.jobs) job.cancel()
    this.renderer.dispose()
    this.completion = Promise.allSettled([...this.jobs].map((job) => job.done)).then(
      () => undefined,
    )
    return this.completion
  }
}
