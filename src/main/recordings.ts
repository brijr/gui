import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, nativeImage, protocol } from 'electron'
import type { RecordingAttachment } from '../shared/types'
import { thumbnail } from './thumbnail'

const MAX_BYTES = 128 * 1024 * 1024
const MAX_VIDEO_BYTES = 32 * 1024 * 1024
const ID = /^[a-f0-9-]{36}$/
/** A clip folder this new is left by the sweep: it may be one being made right now. */
const SWEEP_GRACE_MS = 60 * 60 * 1000
export const recordingProjectKey = (root: string) =>
  createHash('sha256').update(root).digest('hex').slice(0, 32)
const base = () => join(app.getPath('userData'), 'recordings')

/** Every project's open Recordings, whose clips in hand the sweep leaves alone. */
const open = new Set<Recordings>()
/** Projects swept since launch. */
const swept = new Set<string>()

interface Manifest extends RecordingAttachment {
  timestamps: number[]
}

interface Draft {
  id: string
  dir: string
  timestamps: number[]
  bytes: number
  width: number
  height: number
  thumbnail: string
  writing: boolean
}

export class Recordings {
  private draft: Draft | null = null
  private retained = new Set<string>()
  private unsent = new Set<string>()
  private disposed = false
  constructor(private root: string) {
    open.add(this)
  }

  /**
   * Once a launch, removes the project's clips no saved chat refers to and no tab holds:
   * unsent ones left by a crash, or by a queued message that was cleared. `referenced` is
   * null when that can't be known, which skips it.
   */
  async sweep(referenced: () => Promise<Set<string> | null>) {
    const key = recordingProjectKey(this.root)
    if (swept.has(key)) return
    swept.add(key)
    const keep = await referenced()
    if (!keep) return
    const folder = join(base(), key)
    for (const id of await readdir(folder).catch(() => [] as string[])) {
      if (!ID.test(id) || keep.has(id)) continue
      const held = [...open].some((other) => other.root === this.root && other.holds(id))
      if (held) continue
      const info = await stat(join(folder, id)).catch(() => null)
      if (!info || Date.now() - info.mtimeMs < SWEEP_GRACE_MS) continue
      await rm(join(folder, id), { recursive: true, force: true })
    }
  }

  private holds(id: string) {
    return this.retained.has(id) || this.unsent.has(id) || this.draft?.id === id
  }

  async start() {
    if (this.disposed || this.draft) throw new Error('A recording is already active.')
    const id = randomUUID()
    const draft: Draft = {
      id,
      dir: this.path(id),
      timestamps: [],
      bytes: 0,
      width: 0,
      height: 0,
      thumbnail: '',
      writing: false,
    }
    this.draft = draft
    try {
      await mkdir(draft.dir, { recursive: true })
      if (this.disposed) throw new Error('Project closed.')
      return id
    } catch (error) {
      await this.discard(id)
      throw error
    }
  }

  async frame(id: string, timestampMs: number, jpeg: Uint8Array) {
    const draft = this.draft
    if (!draft || draft.id !== id || draft.writing || this.disposed) return false
    if (
      !Number.isFinite(timestampMs) ||
      timestampMs < 0 ||
      timestampMs > 61_000 ||
      timestampMs <= (draft.timestamps.at(-1) ?? -1)
    )
      throw new Error('Invalid frame timestamp.')
    if (
      !(jpeg instanceof Uint8Array) ||
      jpeg.byteLength > 3 * 1024 * 1024 ||
      draft.bytes + jpeg.byteLength > MAX_BYTES ||
      draft.timestamps.length >= 1830
    )
      throw new Error('Recording reached its storage limit.')
    const image = nativeImage.createFromBuffer(Buffer.from(jpeg))
    const { width, height } = image.getSize()
    if (image.isEmpty() || width > 1920 || height > 1920)
      throw new Error('Invalid recording frame.')
    if (!draft.timestamps.length) {
      draft.width = width
      draft.height = height
      draft.thumbnail =
        thumbnail(`data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`) ?? ''
    }
    draft.writing = true
    try {
      await writeFile(join(draft.dir, `${draft.timestamps.length}.jpg`), jpeg)
      draft.timestamps.push(timestampMs)
      draft.bytes += jpeg.byteLength
      return true
    } finally {
      draft.writing = false
    }
  }

  async finish(id: string, durationMs: number, video: Uint8Array): Promise<RecordingAttachment> {
    const draft = this.draft
    if (!draft || draft.id !== id || this.disposed || draft.writing)
      throw new Error('Recording is no longer active.')
    if (
      !Number.isFinite(durationMs) ||
      durationMs < (draft.timestamps.at(-1) ?? 0) ||
      durationMs > 61_000 ||
      !draft.timestamps.length
    )
      throw new Error('No usable recording frames.')
    if (
      !(video instanceof Uint8Array) ||
      video.byteLength < 4 ||
      video.byteLength > MAX_VIDEO_BYTES ||
      Buffer.from(video.subarray(0, 4)).toString('hex') !== '1a45dfa3'
    )
      throw new Error('Invalid or oversized recording video.')
    const manifest: Manifest = {
      id,
      name: 'Preview recording',
      url: `gui-recording://${recordingProjectKey(this.root)}/${id}/video.webm`,
      thumbnail: draft.thumbnail,
      durationMs,
      width: draft.width,
      height: draft.height,
      frameCount: draft.timestamps.length,
      timestamps: draft.timestamps,
    }
    await writeFile(join(draft.dir, 'video.webm'), video)
    await writeFile(join(draft.dir, 'manifest.json'), JSON.stringify(manifest))
    this.draft = null
    this.unsent.add(id)
    return this.attachment(manifest)
  }

  async info(id: string): Promise<Manifest> {
    const manifest: Manifest = JSON.parse(
      await readFile(join(this.path(id), 'manifest.json'), 'utf8'),
    )
    if (manifest.id !== id || !Array.isArray(manifest.timestamps))
      throw new Error('Recording is unavailable.')
    return manifest
  }

  async attachments(ids: string[]) {
    const manifests = await Promise.all(ids.map((id) => this.info(id)))
    return manifests.map((manifest) => this.attachment(manifest))
  }

  retain(ids: string[]) {
    for (const id of ids) {
      this.retained.add(id)
      this.unsent.delete(id)
    }
  }

  async frameAt(id: string, index: number) {
    const manifest = await this.info(id)
    if (!Number.isInteger(index) || index < 0 || index >= manifest.frameCount)
      throw new Error('Frame index is outside this recording.')
    const data = await readFile(join(this.path(id), `${index}.jpg`))
    return { index, timestampMs: manifest.timestamps[index], data: data.toString('base64') }
  }

  async overview(id: string) {
    const { frameCount } = await this.info(id)
    const indexes = [...new Set([0, Math.floor((frameCount - 1) / 2), frameCount - 1])]
    return Promise.all(indexes.map((index) => this.frameAt(id, index)))
  }

  async frames(id: string, startMs: number, endMs: number, fps: number) {
    const { timestamps } = await this.info(id)
    if (endMs < startMs) throw new Error('endMs must be at least startMs.')
    const indexes: number[] = []
    let next = startMs
    for (let index = 0; index < timestamps.length; index++) {
      const at = timestamps[index]
      if (at < next || at > endMs) continue
      indexes.push(index)
      next = at + 1000 / fps - 1
    }
    if (indexes.length > 12)
      throw new Error(
        'At most 12 frames per response. Request a shorter range or lower fps; use recording_frame for exact indexes.',
      )
    return Promise.all(indexes.map((index) => this.frameAt(id, index)))
  }

  async discard(id: string) {
    if (this.retained.has(id)) return
    this.unsent.delete(id)
    if (this.draft?.id === id) this.draft = null
    await rm(this.path(id), { recursive: true, force: true })
  }

  dispose() {
    this.disposed = true
    open.delete(this)
    for (const id of this.unsent) void this.discard(id).catch(console.error)
    if (this.draft) void this.discard(this.draft.id).catch(console.error)
  }

  private path(id: string) {
    if (!ID.test(id)) throw new Error('Invalid recording ID.')
    return join(base(), recordingProjectKey(this.root), id)
  }

  private attachment({ timestamps: _timestamps, ...attachment }: Manifest) {
    return attachment
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gui-recording',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
])

/** Only Gui's UI session has this protocol; preview pages cannot read stored clips. */
export function registerRecordingProtocol() {
  protocol.handle('gui-recording', async (request) => {
    try {
      const url = new URL(request.url)
      const match = /^\/([a-f0-9-]{36})\/video\.webm$/.exec(url.pathname)
      if (
        !/^[a-f0-9]{32}$/.test(url.hostname) ||
        !match ||
        !['GET', 'HEAD'].includes(request.method)
      )
        return new Response(null, { status: 404 })
      const dir = join(base(), url.hostname, match[1])
      await readFile(join(dir, 'manifest.json'))
      const video = await readFile(join(dir, 'video.webm'))
      const headers: Record<string, string> = {
        'Content-Type': 'video/webm',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(video.length),
      }
      const range = request.headers.get('range')
      if (range) {
        const parts = /^bytes=(\d+)-(\d*)$/.exec(range)
        if (!parts) return new Response(null, { status: 416 })
        const start = Number(parts[1])
        const end = parts[2] ? Math.min(Number(parts[2]), video.length - 1) : video.length - 1
        if (start > end || start >= video.length)
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${video.length}` },
          })
        headers['Content-Range'] = `bytes ${start}-${end}/${video.length}`
        headers['Content-Length'] = String(end - start + 1)
        return new Response(request.method === 'HEAD' ? null : video.subarray(start, end + 1), {
          status: 206,
          headers,
        })
      }
      return new Response(request.method === 'HEAD' ? null : video, { headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
