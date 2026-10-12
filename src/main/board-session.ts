import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { type FSWatcher, watch } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { BrowserWindow, type NativeImage } from 'electron'
import {
  BOARD_MANIFEST,
  type BoardCamera,
  type BoardFrameLayout,
  type BoardManifest,
  clampEdge,
  clampZoom,
  cleanName,
  FRAMES_DIR,
  frameId,
  isFrameId,
  MAX_FRAMES,
  parseManifest,
  placeFrame,
  starterHtml,
} from '../shared/board'
import type { BoardFrame, BoardState } from '../shared/types'
import { readManifest, thumbsDir, thumbsUrl, writeManifest } from './board'
import { PREVIEW_PARTITION } from './storage'

/** Changes to a frame's file come in bursts as it's written; look once they've settled. */
const SETTLE_MS = 250
/** A page that loaded gets this long to draw (fonts, images, a script's first render). */
const DRAW_MS = 400
/** A page that hasn't loaded by then is captured as it is. */
const LOAD_TIMEOUT_MS = 8000
/** Thumbnails are this wide at most: sharp at the board's usual zoom, small on disk. */
const THUMB_WIDTH = 720
/** How tall a frame is captured at most; a very tall frame shows its top. */
const CAPTURE_MAX_HEIGHT = 3000
/** How many of the user's own board changes ⌘Z can undo. */
const MAX_UNDO = 50

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
}

/** A board change the user made, and how to take it back: the layout and pages before it. */
interface UndoEntry {
  frames: BoardFrameLayout[]
  /** Pages of frames the change removed, to write back */
  files: Record<string, string>
}

export interface NewFrame {
  name: string
  width: number
  height: number
  /** Its page; a starter page when not given */
  html?: string
  /** Where on the board; placed beside `after` (or everything) when not given */
  at?: { x: number; y: number }
  /** Frames to place it beside, such as the one it's a variation of */
  after?: string[]
}

export interface BoardSessionEvents {
  /** Anything the board shows changed */
  change: []
  /** A frame's page was rewritten, so a preview showing it should load it again */
  frameChanged: [id: string]
}

/**
 * An open canvas (main/board.ts): its frames and their layout, kept in step with the frame
 * files whoever writes them (the user's board, the agent's canvas tools, the agent editing
 * files directly, an undone turn); a loopback server for its pages and thumbnails; and its
 * thumbnails, captured offscreen as pages change.
 */
export class BoardSession extends EventEmitter<BoardSessionEvents> {
  readonly root: string
  readonly id: string
  private manifest: BoardManifest = {
    version: 1,
    name: 'Untitled canvas',
    createdAt: 0,
    frames: [],
    camera: null,
  }
  /** Bumped per frame each time its page or thumbnail changes */
  private versions = new Map<string, number>()
  private captured = new Set<string>()
  private selection: string[] = []
  private openFrame: string | null = null
  private undoStack: UndoEntry[] = []
  /** The manifest as Gui last wrote it, to tell its own writes from anyone else's */
  private written = ''
  private server: Server | null = null
  private token = randomBytes(16).toString('hex')
  private port = 0
  private watchers: FSWatcher[] = []
  private timers = new Map<string, NodeJS.Timeout>()
  private saveTimer: NodeJS.Timeout | null = null
  private capturing: Promise<void> = Promise.resolve()
  private queued = new Set<string>()
  private capturer: BrowserWindow | null = null
  private disposed = false

  constructor(root: string, id: string) {
    super()
    this.root = resolve(root)
    this.id = id
  }

  async open() {
    this.manifest = await readManifest(this.root)
    this.written = JSON.stringify(this.manifest)
    await this.syncFrames()
    await this.serve()
    this.watch()
    // Thumbnails from last time show at once; a page newer than its thumbnail is captured again.
    await Promise.all(
      this.manifest.frames.map(async (frame) => {
        const [page, thumb] = await Promise.all([
          stat(this.framePath(frame.id)).catch(() => null),
          stat(this.thumbPath(frame.id)).catch(() => null),
        ])
        if (thumb) this.captured.add(frame.id)
        if (!thumb || (page && page.mtimeMs > thumb.mtimeMs)) this.queueCapture(frame.id)
      }),
    )
  }

  get name() {
    return this.manifest.name
  }

  get frames(): readonly BoardFrameLayout[] {
    return this.manifest.frames
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`
  }

  /** The page's address in the preview */
  frameUrl(id: string) {
    return `${this.origin}/${this.token}/${FRAMES_DIR}/${id}.html`
  }

  /** The frame a preview address shows, when it's one of this canvas's pages */
  frameAt(url: string | null): string | null {
    if (!url) return null
    const prefix = `${this.origin}/${this.token}/${FRAMES_DIR}/`
    if (!url.startsWith(prefix)) return null
    const id = url.slice(prefix.length).replace(/\.html([?#].*)?$/, '')
    return this.has(id) ? id : null
  }

  framePath(id: string) {
    return join(this.root, FRAMES_DIR, `${id}.html`)
  }

  has(id: string) {
    return this.manifest.frames.some((frame) => frame.id === id)
  }

  frame(id: string) {
    return this.manifest.frames.find((frame) => frame.id === id) ?? null
  }

  get selected(): readonly string[] {
    return this.selection
  }

  get openId(): string | null {
    return this.openFrame
  }

  state(): BoardState {
    return {
      id: this.id,
      name: this.manifest.name,
      frames: this.manifest.frames.map(
        (frame): BoardFrame => ({
          ...frame,
          version: this.versions.get(frame.id) ?? 0,
          captured: this.captured.has(frame.id),
        }),
      ),
      selection: this.selection,
      open: this.openFrame,
      camera: this.manifest.camera,
      thumbs: thumbsUrl(this.id),
      canUndo: this.undoStack.length > 0,
    }
  }

  // The user's board

  select(ids: string[]) {
    const next = [...new Set(ids.filter((id) => this.has(id)))]
    if (next.join() === this.selection.join()) return
    this.selection = next
    this.emit('change')
  }

  setOpen(id: string | null) {
    const next = id && this.has(id) ? id : null
    if (next === this.openFrame) return
    this.openFrame = next
    if (next && !this.selection.includes(next)) this.selection = [next]
    this.emit('change')
  }

  setCamera({ x, y, zoom }: BoardCamera) {
    const camera = { x: Math.round(x), y: Math.round(y), zoom: clampZoom(zoom) }
    this.manifest = { ...this.manifest, camera }
    // Panning saves often; one write once it rests. Not a change anything else shows.
    this.scheduleSave()
  }

  /** Moves and resizes frames; one undo step for all of them. */
  arrange(updates: { id: string; x: number; y: number; width?: number; height?: number }[]) {
    const byId = new Map(updates.map((update) => [update.id, update]))
    if (![...byId.keys()].some((id) => this.has(id))) return
    this.remember()
    this.setFrames(
      this.manifest.frames.map((frame) => {
        const update = byId.get(frame.id)
        if (!update) return frame
        return {
          ...frame,
          x: Math.round(update.x),
          y: Math.round(update.y),
          width: update.width === undefined ? frame.width : clampEdge(update.width),
          height: update.height === undefined ? frame.height : clampEdge(update.height),
        }
      }),
    )
    for (const update of updates) {
      if (update.width !== undefined || update.height !== undefined) this.queueCapture(update.id)
    }
  }

  async rename(id: string, input: string, user = true) {
    const name = cleanName(input)
    const frame = this.frame(id)
    if (!name || !frame || frame.name === name) return
    if (user) this.remember()
    this.setFrames(this.manifest.frames.map((f) => (f.id === id ? { ...f, name } : f)))
  }

  async renameBoard(input: string) {
    const name = cleanName(input)
    if (!name || name === this.manifest.name) return
    this.manifest = { ...this.manifest, name }
    await this.save()
    this.emit('change')
  }

  /** A new frame with its page written; the user's (undoable) or the agent's. */
  async create(spec: NewFrame, user = true): Promise<BoardFrameLayout> {
    if (this.manifest.frames.length >= MAX_FRAMES)
      throw new Error(`A canvas holds up to ${MAX_FRAMES} frames. Delete some first.`)
    const name = cleanName(spec.name) ?? 'Frame'
    const taken = new Set(this.manifest.frames.map((frame) => frame.id))
    // A file left behind (deleted from the board, not the disk) keeps its name.
    for (const file of await readdir(join(this.root, FRAMES_DIR)).catch(() => [] as string[]))
      taken.add(file.replace(/\.html$/, ''))
    const id = frameId(name, taken)
    const size = { width: clampEdge(spec.width), height: clampEdge(spec.height) }
    const after = (spec.after ?? []).flatMap((id) => this.frame(id) ?? [])
    const at = spec.at ?? placeFrame(this.manifest.frames, size, after)
    const frame: BoardFrameLayout = { id, name, x: Math.round(at.x), y: Math.round(at.y), ...size }
    if (user) this.remember()
    // On the board before its file appears, so the watcher finds it already placed.
    this.setFrames([...this.manifest.frames, frame])
    await this.save()
    await mkdir(join(this.root, FRAMES_DIR), { recursive: true })
    await writeFile(this.framePath(id), spec.html ?? starterHtml(name))
    this.queueCapture(id)
    return frame
  }

  /** Copies of frames beside the originals, selected in their place. */
  async duplicate(ids: string[], user = true): Promise<BoardFrameLayout[]> {
    const sources = ids.flatMap((id) => this.frame(id) ?? [])
    if (!sources.length) return []
    if (user) this.remember()
    const made: BoardFrameLayout[] = []
    for (const source of sources) {
      const html = await readFile(this.framePath(source.id), 'utf8').catch(() => undefined)
      made.push(
        await this.create(
          {
            name: `${source.name} copy`,
            width: source.width,
            height: source.height,
            html,
            after: [source.id, ...made.map((frame) => frame.id)],
          },
          false,
        ),
      )
    }
    this.select(made.map((frame) => frame.id))
    return made
  }

  /** Off the board, and their pages deleted; the user's can be undone. */
  async remove(ids: string[], user = true) {
    const gone = new Set(ids.filter((id) => this.has(id)))
    if (!gone.size) return
    const files: Record<string, string> = {}
    for (const id of gone) {
      const html = await readFile(this.framePath(id), 'utf8').catch(() => null)
      if (html !== null) files[id] = html
    }
    if (user) this.remember(files)
    this.setFrames(this.manifest.frames.filter((frame) => !gone.has(frame.id)))
    this.selection = this.selection.filter((id) => !gone.has(id))
    if (this.openFrame && gone.has(this.openFrame)) this.openFrame = null
    await this.save()
    await Promise.all(
      [...gone].flatMap((id) => [
        rm(this.framePath(id), { force: true }),
        rm(this.thumbPath(id), { force: true }),
      ]),
    )
    this.emit('change')
  }

  /** Takes back the user's last board change; false when there's none to take back. */
  async undo() {
    const entry = this.undoStack.pop()
    if (!entry) return false
    const kept = new Set(entry.frames.map((frame) => frame.id))
    const added = this.manifest.frames.filter((frame) => !kept.has(frame.id))
    for (const [id, html] of Object.entries(entry.files)) {
      await writeFile(this.framePath(id), html)
      this.queueCapture(id)
    }
    this.setFrames(entry.frames)
    this.selection = this.selection.filter((id) => kept.has(id))
    if (this.openFrame && !kept.has(this.openFrame)) this.openFrame = null
    await this.save()
    await Promise.all(added.map((frame) => rm(this.framePath(frame.id), { force: true })))
    this.emit('change')
    return true
  }

  /** The agent changed the canvas: what the user did before it can't be undone on its own. */
  forgetUndo() {
    if (!this.undoStack.length) return
    this.undoStack = []
    this.emit('change')
  }

  async captureNow(id: string) {
    this.queueCapture(id)
    await this.capturing
  }

  thumbPath(id: string) {
    return join(thumbsDir(this.id), `${id}.jpg`)
  }

  // Keeping in step with the files

  private remember(files: Record<string, string> = {}) {
    this.undoStack.push({ frames: this.manifest.frames, files })
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
  }

  private setFrames(frames: BoardFrameLayout[]) {
    this.manifest = { ...this.manifest, frames }
    this.scheduleSave(0)
    this.emit('change')
  }

  /** Frames whose page is gone leave the board; pages without a frame join it. */
  private async syncFrames() {
    const files = new Set(
      (await readdir(join(this.root, FRAMES_DIR)).catch(() => [] as string[]))
        .filter((file) => file.endsWith('.html'))
        .map((file) => file.slice(0, -'.html'.length))
        .filter(isFrameId),
    )
    let frames = this.manifest.frames.filter((frame) => files.has(frame.id))
    const known = new Set(frames.map((frame) => frame.id))
    for (const id of [...files].sort()) {
      if (known.has(id) || frames.length >= MAX_FRAMES) continue
      const size = { width: 1440, height: 900 }
      const last = frames.at(-1)
      frames = [
        ...frames,
        { id, name: id, ...size, ...placeFrame(frames, size, last ? [last] : []) },
      ]
      this.queueCapture(id)
    }
    const changed =
      frames.length !== this.manifest.frames.length ||
      frames.some((frame, i) => frame !== this.manifest.frames[i])
    if (!changed) return false
    this.manifest = { ...this.manifest, frames }
    // Undoing the user's earlier layout would now take these frames off the board too.
    this.undoStack = []
    this.selection = this.selection.filter((id) => files.has(id))
    if (this.openFrame && !files.has(this.openFrame)) this.openFrame = null
    await this.save()
    return true
  }

  private watch() {
    const onFrame = (file: string | null) => {
      if (!file?.endsWith('.html')) return
      const id = file.slice(0, -'.html'.length)
      if (isFrameId(id)) this.settle(`frame:${id}`, () => this.onFrameFile(id))
    }
    const onRoot = (file: string | null) => {
      if (file === BOARD_MANIFEST) this.settle('manifest', () => this.onManifestFile())
      // Undoing a turn can put the whole frames folder back.
      if (file === FRAMES_DIR) this.settle('frames', () => this.resync())
    }
    for (const [dir, listener] of [
      [join(this.root, FRAMES_DIR), onFrame],
      [this.root, onRoot],
    ] as const) {
      try {
        const watcher = watch(dir, (_event, file) => listener(file))
        watcher.on('error', () => undefined)
        this.watchers.push(watcher)
      } catch (error) {
        console.error('[gui] could not watch the canvas', error)
      }
    }
  }

  private settle(key: string, run: () => Promise<void>) {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        if (!this.disposed)
          run().catch((error: unknown) => console.error('[gui] canvas sync failed', error))
      }, SETTLE_MS),
    )
  }

  private async onFrameFile(id: string) {
    const exists = await stat(this.framePath(id)).then(
      (info) => info.isFile(),
      () => false,
    )
    if (exists !== this.has(id)) {
      await this.resync()
      return
    }
    if (!exists) return
    this.queueCapture(id)
    this.emit('frameChanged', id)
  }

  /** Someone else wrote the manifest (the agent by hand, or an undone turn): take it as it is. */
  private async onManifestFile() {
    const text = await readFile(join(this.root, BOARD_MANIFEST), 'utf8').catch(() => null)
    if (text === null) {
      await this.save()
      return
    }
    const next = parseManifest(text, this.manifest.name)
    if (JSON.stringify(next) === this.written) return
    const before = new Set(this.manifest.frames.map((frame) => frame.id))
    this.manifest = { ...next, camera: this.manifest.camera }
    this.written = JSON.stringify(this.manifest)
    this.undoStack = []
    await this.syncFrames()
    for (const frame of this.manifest.frames) if (!before.has(frame.id)) this.queueCapture(frame.id)
    this.emit('change')
  }

  private async resync() {
    const before = new Set(this.manifest.frames.map((frame) => frame.id))
    await this.syncFrames()
    for (const frame of this.manifest.frames) {
      if (before.has(frame.id)) continue
      this.queueCapture(frame.id)
      this.emit('frameChanged', frame.id)
    }
    this.emit('change')
  }

  private scheduleSave(delay = 500) {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save().catch((error: unknown) =>
        console.error('[gui] failed to save the canvas', error),
      )
    }, delay)
  }

  async save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const text = JSON.stringify(this.manifest)
    if (text === this.written) return
    this.written = text
    await writeManifest(this.root, this.manifest)
  }

  // Serving its pages

  private async serve() {
    const server = createServer((req, res) => {
      void this.respond(req.url ?? '/', req.method ?? 'GET')
        .then(({ status, type, body }) => {
          res.writeHead(status, {
            'Content-Type': type,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
    })
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => done())
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  private async respond(url: string, method: string) {
    const notFound = { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' }
    if (method !== 'GET' && method !== 'HEAD') return { ...notFound, status: 405 }
    const path = decodeURIComponent(url.split(/[?#]/)[0])
    const prefix = `/${this.token}/`
    if (!path.startsWith(prefix)) return notFound
    const rest = path.slice(prefix.length)
    // Only inside the canvas's folder, symbolic links included, and never its manifest.
    const file = resolve(this.root, rest)
    if (!file.startsWith(this.root + sep) || rest === BOARD_MANIFEST) return notFound
    const real = await realpath(file).catch(() => null)
    const root = await realpath(this.root).catch(() => this.root)
    if (!real?.startsWith(root + sep)) return notFound
    const info = await stat(real).catch(() => null)
    if (!info?.isFile()) return notFound
    const type = CONTENT_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream'
    return { status: 200, type, body: await readFile(real) }
  }

  // Thumbnails

  private queueCapture(id: string) {
    if (this.queued.has(id) || this.disposed) return
    this.queued.add(id)
    this.capturing = this.capturing.then(async () => {
      this.queued.delete(id)
      if (this.disposed || !this.has(id)) return
      try {
        await this.capture(id)
      } catch (error) {
        console.error(`[gui] could not capture frame ${id}`, error)
      }
    })
  }

  /** Loads the page offscreen at the frame's size, and keeps a small JPEG of it. */
  private async capture(id: string) {
    const image = await this.render(id)
    if (!image || this.disposed) return
    const small =
      image.getSize().width > THUMB_WIDTH
        ? image.resize({ width: THUMB_WIDTH, quality: 'good' })
        : image
    await mkdir(thumbsDir(this.id), { recursive: true })
    await writeFile(this.thumbPath(id), small.toJPEG(82))
    if (this.disposed) return
    this.captured.add(id)
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
    this.emit('change')
  }

  /** The frame's page as it looks at the frame's size, rendered offscreen; one at a time. */
  screenshot(id: string): Promise<NativeImage> {
    const shot = this.capturing.then(() => this.render(id))
    this.capturing = shot.then(
      () => undefined,
      () => undefined,
    )
    return shot.then((image) => {
      if (!image) throw new Error(`Couldn't render frame ${id}.`)
      return image
    })
  }

  private async render(id: string): Promise<NativeImage | null> {
    const frame = this.frame(id)
    if (!frame || !this.port || this.disposed) return null
    const win = this.capturerWindow()
    const width = frame.width
    const height = Math.min(frame.height, CAPTURE_MAX_HEIGHT)
    win.setContentSize(width, height)
    const wc = win.webContents
    await new Promise<void>((done) => {
      const timer = setTimeout(done, LOAD_TIMEOUT_MS)
      wc.once('did-stop-loading', () => {
        clearTimeout(timer)
        done()
      })
      wc.loadURL(this.frameUrl(id)).catch(() => undefined)
    })
    await new Promise((done) => setTimeout(done, DRAW_MS))
    if (this.disposed || win.isDestroyed()) return null
    const image = await wc.capturePage({ x: 0, y: 0, width, height })
    return image.isEmpty() ? null : image
  }

  private capturerWindow() {
    if (this.capturer && !this.capturer.isDestroyed()) return this.capturer
    this.capturer = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      useContentSize: true,
      enableLargerThanScreen: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: PREVIEW_PARTITION,
      },
    })
    const wc = this.capturer.webContents
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${this.origin}/${this.token}/`)) event.preventDefault()
    })
    return this.capturer
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const watcher of this.watchers) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.server?.close()
    if (this.capturer && !this.capturer.isDestroyed()) this.capturer.destroy()
    this.capturer = null
    await this.save().catch(() => undefined)
  }
}
