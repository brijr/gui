import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, nativeImage, protocol } from 'electron'
import {
  MAX_NARRATED_RECORDING_MS,
  MAX_RECORDING_AUDIO_BYTES,
  MAX_RECORDING_FRAMES,
  MAX_RECORDING_MS,
  MAX_RECORDING_VIDEO_BYTES,
} from '../shared/bounded'
import type { RecordingAttachment, RecordingNarration } from '../shared/types'
import type { CursorLog } from './recording-cursor'
import { captionsVtt, transcriptText } from './recording-narration'
import type { TraceEntry } from './recording-trace'
import { thumbnail } from './thumbnail'
import { type Transcript, transcribe } from './transcribe'

const MAX_BYTES = 128 * 1024 * 1024
/** Kept with the clip (and in chat history); the full transcript is in transcript.json. */
const MAX_NARRATION_TEXT = 4000
/** A clip may run this much past its limit: the recorder stops on a timer. */
const SLACK_MS = 1000
const limitMs = (narrated: boolean) =>
  (narrated ? MAX_NARRATED_RECORDING_MS : MAX_RECORDING_MS) + SLACK_MS
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

export interface FinishedRecording {
  timeline?: TraceEntry[]
  cursor?: CursorLog | null
  /** 16 kHz mono WAV of what the user said, for a narrated clip */
  audio?: Uint8Array | null
}

interface Draft {
  id: string
  narrated: boolean
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
  /** Narrated clips being transcribed, by ID */
  private jobs = new Map<string, { done: Promise<void>; abort: AbortController }>()
  constructor(
    private root: string,
    /** A clip changed after it was attached (its transcript came in) */
    private onUpdate: (clip: RecordingAttachment) => void = () => {},
  ) {
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

  async start(narrated = false) {
    if (this.disposed || this.draft) throw new Error('A recording is already active.')
    const id = randomUUID()
    const draft: Draft = {
      id,
      narrated,
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
      timestampMs > limitMs(draft.narrated) ||
      timestampMs <= (draft.timestamps.at(-1) ?? -1)
    )
      throw new Error('Invalid frame timestamp.')
    if (
      !(jpeg instanceof Uint8Array) ||
      jpeg.byteLength > 3 * 1024 * 1024 ||
      draft.bytes + jpeg.byteLength > MAX_BYTES ||
      draft.timestamps.length >= MAX_RECORDING_FRAMES
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

  async finish(
    id: string,
    durationMs: number,
    video: Uint8Array,
    { timeline = [], cursor = null, audio = null }: FinishedRecording = {},
  ): Promise<RecordingAttachment> {
    const draft = this.draft
    if (!draft || draft.id !== id || this.disposed || draft.writing)
      throw new Error('Recording is no longer active.')
    if (
      !Number.isFinite(durationMs) ||
      durationMs < (draft.timestamps.at(-1) ?? 0) ||
      durationMs > limitMs(draft.narrated) ||
      !draft.timestamps.length
    )
      throw new Error('No usable recording frames.')
    if (
      !(video instanceof Uint8Array) ||
      video.byteLength < 4 ||
      video.byteLength > MAX_RECORDING_VIDEO_BYTES ||
      Buffer.from(video.subarray(0, 4)).toString('hex') !== '1a45dfa3'
    )
      throw new Error('Invalid or oversized recording video.')
    const sound = draft.narrated && audio && isWav(audio) ? audio : null
    if (audio && !sound) throw new Error('Invalid or oversized recording audio.')
    const manifest: Manifest = {
      id,
      name: draft.narrated ? 'Narrated recording' : 'Preview recording',
      url: `gui-recording://${recordingProjectKey(this.root)}/${id}/video.webm`,
      thumbnail: draft.thumbnail,
      durationMs,
      width: draft.width,
      height: draft.height,
      frameCount: draft.timestamps.length,
      timestamps: draft.timestamps,
      ...(draft.narrated
        ? {
            narration: sound
              ? { status: 'transcribing' as const }
              : { status: 'failed' as const, error: 'No sound was recorded.' },
          }
        : {}),
    }
    await writeFile(join(draft.dir, 'video.webm'), video)
    await writeFile(join(draft.dir, 'timeline.json'), JSON.stringify(timeline))
    if (cursor) await writeFile(join(draft.dir, 'cursor.json'), JSON.stringify(cursor))
    if (sound) await writeFile(join(draft.dir, 'audio.wav'), sound)
    await writeFile(join(draft.dir, 'manifest.json'), JSON.stringify(manifest))
    this.draft = null
    this.unsent.add(id)
    if (sound) this.transcribe(id)
    return this.attachment(manifest)
  }

  /**
   * Transcribes a narrated clip in the background; its narration says how that went once
   * it's done, and `onUpdate` passes the clip on. The audio is deleted either way.
   */
  private transcribe(id: string) {
    const abort = new AbortController()
    const dir = this.path(id)
    const audio = join(dir, 'audio.wav')
    const done = (async () => {
      let narration: RecordingNarration
      try {
        const transcript = await transcribe(audio, abort.signal)
        const text = transcriptText(transcript)
        if (abort.signal.aborted) return
        if (text) {
          await writeFile(join(dir, 'transcript.json'), JSON.stringify(transcript))
          await writeFile(join(dir, 'captions.vtt'), captionsVtt(transcript))
          narration = {
            status: 'done',
            text:
              text.length > MAX_NARRATION_TEXT ? `${text.slice(0, MAX_NARRATION_TEXT - 1)}…` : text,
            captions: `gui-recording://${recordingProjectKey(this.root)}/${id}/captions.vtt`,
          }
        } else narration = { status: 'failed', error: "Couldn't hear any speech." }
      } catch (error) {
        if (abort.signal.aborted) return
        console.error('[gui] transcription failed', error)
        narration = {
          status: 'failed',
          error: error instanceof Error ? error.message : "Couldn't transcribe the recording.",
        }
      }
      await rm(audio, { force: true }).catch(() => undefined)
      if (abort.signal.aborted || this.disposed) return
      const manifest = await this.info(id).catch(() => null)
      if (!manifest || abort.signal.aborted) return
      const next: Manifest = { ...manifest, narration }
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(next))
      if (!abort.signal.aborted && !this.disposed) this.onUpdate(this.attachment(next))
    })()
      .catch((error: unknown) => console.error('[gui] failed to save a transcript', error))
      .finally(() => {
        if (this.jobs.get(id)?.abort === abort) this.jobs.delete(id)
      })
    this.jobs.set(id, { done, abort })
  }

  /** The clips as they are once any transcripts still being made are done (or `timeoutMs` passes). */
  async settled(ids: string[], timeoutMs: number) {
    const running = ids.flatMap((id) => {
      const job = this.jobs.get(id)
      return job ? [job.done] : []
    })
    if (running.length) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.all(running),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
      clearTimeout(timer)
    }
    return this.attachments(ids)
  }

  /** A narrated clip's transcript with word times; null when it has none. */
  async transcript(id: string): Promise<Transcript | null> {
    await this.info(id)
    const data: unknown = JSON.parse(
      await readFile(join(this.path(id), 'transcript.json'), 'utf8').catch(() => 'null'),
    )
    const transcript = data as Transcript | null
    return transcript && Array.isArray(transcript.segments) ? transcript : null
  }

  /** Where the pointer was while it was recorded; null for clips from before it was tracked. */
  async cursor(id: string): Promise<CursorLog | null> {
    await this.info(id)
    const data: unknown = JSON.parse(
      await readFile(join(this.path(id), 'cursor.json'), 'utf8').catch(() => 'null'),
    )
    const cursor = data as CursorLog | null
    return cursor && Array.isArray(cursor.samples) && Array.isArray(cursor.dwells) ? cursor : null
  }

  async info(id: string): Promise<Manifest> {
    const manifest: Manifest = JSON.parse(
      await readFile(join(this.path(id), 'manifest.json'), 'utf8'),
    )
    if (manifest.id !== id || !Array.isArray(manifest.timestamps))
      throw new Error('Recording is unavailable.')
    return manifest
  }

  /** What happened in the page while it was recorded (recording-trace.ts); empty for older clips. */
  async timeline(id: string): Promise<TraceEntry[]> {
    await this.info(id)
    const entries: unknown = JSON.parse(
      await readFile(join(this.path(id), 'timeline.json'), 'utf8').catch(() => '[]'),
    )
    return Array.isArray(entries) ? entries : []
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
    this.jobs.get(id)?.abort.abort()
    if (this.draft?.id === id) this.draft = null
    await rm(this.path(id), { recursive: true, force: true })
  }

  dispose() {
    this.disposed = true
    open.delete(this)
    for (const job of this.jobs.values()) job.abort.abort()
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

/** A 16-bit PCM WAV small enough to be a narrated clip's audio. */
function isWav(audio: Uint8Array) {
  return (
    audio instanceof Uint8Array &&
    audio.byteLength > 44 &&
    audio.byteLength <= MAX_RECORDING_AUDIO_BYTES &&
    Buffer.from(audio.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(audio.subarray(8, 12)).toString('latin1') === 'WAVE'
  )
}

// Every privileged scheme in one call: a second call would replace this one's.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gui-recording',
    // corsEnabled: a narrated clip's player loads its captions, and so its video, with CORS.
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  // A canvas's frame thumbnails, for its board (main/board.ts).
  { scheme: 'gui-thumb', privileges: { standard: true, secure: true } },
])

/**
 * A narrated clip's player loads its captions with a <track>, which needs CORS, and so does
 * its video then. Only Gui's own pages are in this session.
 */
const SHARED = { 'Access-Control-Allow-Origin': '*' }

/** Only Gui's UI session has this protocol; preview pages cannot read stored clips. */
export function registerRecordingProtocol() {
  protocol.handle('gui-recording', async (request) => {
    try {
      const url = new URL(request.url)
      const match = /^\/([a-f0-9-]{36})\/(video\.webm|captions\.vtt)$/.exec(url.pathname)
      if (
        !/^[a-f0-9]{32}$/.test(url.hostname) ||
        !match ||
        !['GET', 'HEAD'].includes(request.method)
      )
        return new Response(null, { status: 404 })
      const dir = join(base(), url.hostname, match[1])
      await readFile(join(dir, 'manifest.json'))
      if (match[2] === 'captions.vtt') {
        const captions = await readFile(join(dir, 'captions.vtt'))
        return new Response(request.method === 'HEAD' ? null : captions, {
          headers: { 'Content-Type': 'text/vtt; charset=utf-8', ...SHARED },
        })
      }
      const video = await readFile(join(dir, 'video.webm'))
      const headers: Record<string, string> = {
        ...SHARED,
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
