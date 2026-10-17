import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import { type BoardFrameLayout, FRAMES_DIR } from '../shared/board'
import { writeFileAtomic } from './atomic-file'
import { boardAssetSignature, pageSignature } from './board-assets'
import {
  type BoardCaptureQueue,
  boardCaptureQueue,
  CAPTURE_PRIORITY,
  type CaptureJob,
} from './board-capture-queue'

/**
 * A thumbnail's widest, in pixels: a desktop frame's own width, so the board stays sharp on a
 * Retina screen up to about 50%.
 */
const THUMB_WIDTH = 1440

export interface BoardCaptureRenderer {
  render(
    frame: BoardFrameLayout,
    url: string,
    scale: number,
    signal: AbortSignal,
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
  private versions = new Map<string, number>()
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

  status(id: string) {
    return { version: this.versions.get(id) ?? 0, captured: this.captured.has(id) }
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
    await Promise.all(
      this.host.frames().map(async (frame) => {
        const [page, thumb] = await Promise.all([
          pageSignature(join(this.host.root, FRAMES_DIR, `${frame.id}.html`)),
          stat(this.path(frame.id)).catch(() => null),
        ])
        if (this.disposed) return
        if (thumb) this.captured.add(frame.id)
        const cached = this.cache[frame.id]
        if (
          !thumb ||
          !page ||
          cached?.assets !== assets ||
          cached.page !== page ||
          cached.width !== frame.width ||
          cached.height !== frame.height ||
          cached.thumbWidth !== THUMB_WIDTH
        )
          void this.thumbnail(frame.id)
      }),
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

  forget(id: string) {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.thumbnails.get(id)?.job.cancel()
    this.thumbnails.delete(id)
    this.captured.delete(id)
    delete this.cache[id]
  }

  async screenshot(id: string, scale = 1): Promise<NativeImage> {
    if (this.disposed) throw new Error('Canvas closed')
    const job = this.queue.schedule(CAPTURE_PRIORITY.interactive, async (signal) => {
      const frame = this.host.frame(id)
      return frame ? this.renderer.render(frame, this.host.url(id), scale, signal) : null
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
    const current = () =>
      !this.disposed &&
      !signal.aborted &&
      this.host.frame(id) !== null &&
      this.revisions.get(id) === revision &&
      this.assets === assets
    const image = await this.renderer.render(frame, this.host.url(id), 1, signal)
    if (!image || !current()) return
    if (page !== (await pageSignature(join(this.host.root, FRAMES_DIR, `${id}.html`)))) {
      void this.thumbnail(id)
      return
    }
    const small =
      image.getSize().width > THUMB_WIDTH
        ? image.resize({ width: THUMB_WIDTH, quality: 'good' })
        : image
    await mkdir(this.host.thumbs, { recursive: true })
    const temp = `${this.path(id)}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temp, small.toJPEG(82))
      if (!current()) return
      await rename(temp, this.path(id))
      if (!current()) return
      this.cache[id] = {
        assets,
        page,
        width: frame.width,
        height: frame.height,
        thumbWidth: THUMB_WIDTH,
      }
      await writeFileAtomic(this.cachePath, JSON.stringify(this.cache))
      if (!current()) return
      this.captured.add(id)
      this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
      this.host.changed(id)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
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
