import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { type FSWatcher, watch } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import type { NativeImage } from 'electron'
import {
  BOARD_MANIFEST,
  type BoardCamera,
  type BoardFrameLayout,
  type BoardManifest,
  type BoardSection,
  clampEdge,
  clampZoom,
  cleanName,
  cleanSections,
  FRAMES_DIR,
  frameId,
  isFrameId,
  MAX_FRAMES,
  parseManifest,
  placeFrame,
  regroupSections,
  sectionBounds,
  sectionId,
  sectionOf,
  starterHtml,
} from '../shared/board'
import type { BoardFrame, BoardState } from '../shared/types'
import { readManifest, thumbsDir, thumbsUrl, writeManifest } from './board'
import { isBoardAsset } from './board-assets'
import { BoardCaptures } from './board-capture'
import { OffscreenBoardRenderer } from './board-capture-renderer'
import { BoardManifestWriter, BoardMutations } from './board-persistence'

/** Changes to a frame's file come in bursts as it's written; look once they've settled. */
const SETTLE_MS = 250
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
  sections: BoardSection[]
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
    sections: [],
    camera: null,
  }
  private readonly mutations = new BoardMutations()
  private readonly writer: BoardManifestWriter
  private readonly captures: BoardCaptures
  private manifestRevision = 0
  private selection: string[] = []
  private openFrame: string | null = null
  private undoStack: UndoEntry[] = []
  private server: Server | null = null
  private token = randomBytes(16).toString('hex')
  private port = 0
  private watchers: FSWatcher[] = []
  private timers = new Map<string, NodeJS.Timeout>()
  private saveTimer: NodeJS.Timeout | null = null
  private disposed = false
  private completion: Promise<void> | null = null

  constructor(root: string, id: string) {
    super()
    this.root = resolve(root)
    this.id = id
    this.writer = new BoardManifestWriter((manifest) => writeManifest(this.root, manifest))
    this.captures = new BoardCaptures(
      {
        root: this.root,
        thumbs: thumbsDir(this.id),
        frames: () => this.frames,
        frame: (id) => this.frame(id),
        url: (id) => this.frameUrl(id),
        changed: () => this.emit('change'),
      },
      new OffscreenBoardRenderer(),
    )
  }

  open() {
    return this.mutations.run(async () => {
      this.manifest = await readManifest(this.root)
      this.writer.observe(this.manifest)
      if (this.disposed) return
      await this.syncFrames()
      if (this.disposed) return
      await this.serve()
      if (this.disposed) return
      this.watch()
      await this.captures.open()
    })
  }

  get name() {
    return this.manifest.name
  }

  get frames(): readonly BoardFrameLayout[] {
    return this.manifest.frames
  }

  get sections(): readonly BoardSection[] {
    return this.manifest.sections
  }

  section(id: string) {
    return this.manifest.sections.find((section) => section.id === id) ?? null
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
          ...this.captures.status(frame.id),
        }),
      ),
      sections: this.manifest.sections,
      selection: this.selection,
      open: this.openFrame,
      camera: this.manifest.camera,
      thumbs: thumbsUrl(this.id),
      canUndo: this.undoStack.length > 0,
    }
  }

  // The user's board

  select(ids: string[]) {
    if (this.disposed) return
    const next = [...new Set(ids.filter((id) => this.has(id)))]
    if (next.join() === this.selection.join()) return
    this.selection = next
    this.captures.prioritize([...this.selection, ...(this.openFrame ? [this.openFrame] : [])])
    this.emit('change')
  }

  setOpen(id: string | null) {
    if (this.disposed) return
    const next = id && this.has(id) ? id : null
    if (next === this.openFrame) return
    this.openFrame = next
    if (next && !this.selection.includes(next)) this.selection = [next]
    this.captures.prioritize([...this.selection, ...(next ? [next] : [])])
    this.emit('change')
  }

  setCamera({ x, y, zoom }: BoardCamera) {
    if (this.disposed) return
    const camera = { x: Math.round(x), y: Math.round(y), zoom: clampZoom(zoom) }
    this.manifest = { ...this.manifest, camera }
    this.manifestRevision++
    // Panning saves often; one write once it rests. Not a change anything else shows.
    this.scheduleSave()
  }

  /**
   * Moves and resizes frames; one undo step for all of them. The user's (`regroup`) drags
   * frames into and out of sections as they land; the agent's leave sections as they are.
   */
  arrange(
    updates: { id: string; x?: number; y?: number; width?: number; height?: number }[],
    regroup = false,
    user = true,
  ) {
    return this.mutations.run(async () => this.arrangeFrames(updates, regroup, user))
  }

  private arrangeFrames(
    updates: { id: string; x?: number; y?: number; width?: number; height?: number }[],
    regroup: boolean,
    user: boolean,
  ) {
    const byId = new Map(updates.map((update) => [update.id, update]))
    if (![...byId.keys()].some((id) => this.has(id))) return
    if (user) this.remember()
    const frames = this.manifest.frames.map((frame) => {
      const update = byId.get(frame.id)
      if (!update) return frame
      return {
        ...frame,
        x: update.x === undefined ? frame.x : Math.round(update.x),
        y: update.y === undefined ? frame.y : Math.round(update.y),
        width: update.width === undefined ? frame.width : clampEdge(update.width),
        height: update.height === undefined ? frame.height : clampEdge(update.height),
      }
    })
    const moved = frames
      .filter((frame, i) => {
        const before = this.manifest.frames[i]
        return frame.x !== before.x || frame.y !== before.y
      })
      .map((frame) => frame.id)
    this.setFrames(
      frames,
      regroup && moved.length
        ? regroupSections(this.manifest.sections, frames, moved, this.manifest.frames)
        : this.manifest.sections,
    )
    for (const update of updates) {
      if (update.width !== undefined || update.height !== undefined) this.queueCapture(update.id)
    }
  }

  rename(id: string, input: string, user = true) {
    return this.mutations.run(async () => {
      const name = cleanName(input)
      const frame = this.frame(id)
      if (!name || !frame || frame.name === name) return
      if (user) this.remember()
      this.setFrames(this.manifest.frames.map((f) => (f.id === id ? { ...f, name } : f)))
    })
  }

  renameBoard(input: string) {
    return this.mutations.run(async () => {
      const name = cleanName(input)
      if (!name || name === this.manifest.name) return
      this.manifest = { ...this.manifest, name }
      this.manifestRevision++
      await this.save()
      this.emit('change')
    })
  }

  /** A new frame with its page written; the user's (undoable) or the agent's. */
  create(spec: NewFrame, user = true): Promise<BoardFrameLayout> {
    return this.mutations.run(() => this.createFrame(spec, user))
  }

  private async createFrame(spec: NewFrame, user: boolean): Promise<BoardFrameLayout> {
    if (this.manifest.frames.length >= MAX_FRAMES)
      throw new Error(`A canvas holds up to ${MAX_FRAMES} frames. Delete some first.`)
    const name = cleanName(spec.name) ?? 'Frame'
    const taken = new Set(this.manifest.frames.map((frame) => frame.id))
    // A file left behind (deleted from the board, not the disk) keeps its name.
    for (const file of await readdir(join(this.root, FRAMES_DIR)).catch(() => [] as string[]))
      taken.add(file.replace(/\.html$/, ''))
    let id = frameId(name, taken)
    await mkdir(join(this.root, FRAMES_DIR), { recursive: true })
    while (true) {
      try {
        // An external file can appear after readdir. Never replace a page we did not create.
        await writeFile(this.framePath(id), spec.html ?? starterHtml(name), { flag: 'wx' })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        taken.add(id)
        id = frameId(name, taken)
      }
    }
    const size = { width: clampEdge(spec.width), height: clampEdge(spec.height) }
    const after = (spec.after ?? []).flatMap((id) => this.frame(id) ?? [])
    // Beside a frame in a section, it joins that section; otherwise it keeps out of them all.
    const { sections } = this.manifest
    const home = after.map((frame) => sectionOf(sections, frame.id)).find(Boolean) ?? null
    const others = sections.flatMap((section) =>
      section.id === home?.id ? [] : (sectionBounds(section, this.manifest.frames) ?? []),
    )
    const at = spec.at ?? placeFrame([...this.manifest.frames, ...others], size, after)
    const frame: BoardFrameLayout = { id, name, x: Math.round(at.x), y: Math.round(at.y), ...size }
    if (user) this.remember()
    // File reconciliation shares this mutation lane: the watcher sees this placement first.
    this.setFrames(
      [...this.manifest.frames, frame],
      sections.map((section) =>
        section.id === home?.id ? { ...section, frames: [...section.frames, id] } : section,
      ),
      false,
    )
    await this.save()
    this.queueCapture(id)
    return frame
  }

  /** Copies of frames beside the originals, selected in their place. */
  duplicate(ids: string[], user = true): Promise<BoardFrameLayout[]> {
    return this.mutations.run(() => this.duplicateFrames(ids, user))
  }

  private async duplicateFrames(ids: string[], user: boolean): Promise<BoardFrameLayout[]> {
    const sources = ids.flatMap((id) => this.frame(id) ?? [])
    if (!sources.length) return []
    if (user) this.remember()
    const made: BoardFrameLayout[] = []
    for (const source of sources) {
      const html = await readFile(this.framePath(source.id), 'utf8').catch(() => undefined)
      made.push(
        await this.createFrame(
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
  remove(ids: string[], user = true) {
    return this.mutations.run(() => this.removeFrames(ids, user))
  }

  private async removeFrames(ids: string[], user: boolean) {
    const gone = new Set(ids.filter((id) => this.has(id)))
    if (!gone.size) return
    const files: Record<string, string> = {}
    for (const id of gone) {
      const html = await readFile(this.framePath(id), 'utf8').catch(() => null)
      if (html !== null) files[id] = html
    }
    if (user) this.remember(files)
    this.setFrames(
      this.manifest.frames.filter((frame) => !gone.has(frame.id)),
      this.manifest.sections,
      false,
    )
    for (const id of gone) this.captures.forget(id)
    this.selection = this.selection.filter((id) => !gone.has(id))
    if (this.openFrame && gone.has(this.openFrame)) this.openFrame = null
    await Promise.all(
      [...gone].flatMap((id) => [
        rm(this.framePath(id), { force: true }),
        rm(this.thumbPath(id), { force: true }),
      ]),
    )
    await this.save()
    this.emit('change')
  }

  /**
   * A new section around `ids`, taking them out of any they were in; named "Section 2" and
   * so on unless given a name. The user's can be undone.
   */
  addSection(ids: string[], input?: string, user = true): Promise<BoardSection | null> {
    return this.mutations.run(async () => this.createSection(ids, input, user))
  }

  private createSection(ids: string[], input: string | undefined, user: boolean) {
    const members = [...new Set(ids.filter((id) => this.has(id)))]
    if (!members.length) return null
    const { sections } = this.manifest
    const name = cleanName(input) ?? `Section ${sections.length + 1}`
    const section = {
      id: sectionId(name, new Set(sections.map((s) => s.id))),
      name,
      frames: members,
    }
    if (user) this.remember()
    this.setFrames(this.manifest.frames, [
      ...sections.map((s) => ({ ...s, frames: s.frames.filter((id) => !members.includes(id)) })),
      section,
    ])
    return section
  }

  /** A section's new name and, for the agent, its frames (taken out of any others). */
  updateSection(id: string, change: { name?: string; frames?: string[] }, user = true) {
    return this.mutations.run(async () => this.changeSection(id, change, user))
  }

  private changeSection(id: string, change: { name?: string; frames?: string[] }, user: boolean) {
    const section = this.section(id)
    if (!section) return
    const name = change.name === undefined ? section.name : (cleanName(change.name) ?? section.name)
    const members = change.frames?.filter((frame) => this.has(frame))
    if (name === section.name && !members) return
    if (user) this.remember()
    this.setFrames(
      this.manifest.frames,
      this.manifest.sections.map((s) => {
        if (s.id === id) return { ...s, name, frames: members ?? s.frames }
        return members ? { ...s, frames: s.frames.filter((f) => !members.includes(f)) } : s
      }),
    )
  }

  /** The section goes; its frames stay where they are. The user's can be undone. */
  removeSection(id: string, user = true) {
    return this.mutations.run(async () => {
      if (!this.section(id)) return
      if (user) this.remember()
      this.setFrames(
        this.manifest.frames,
        this.manifest.sections.filter((section) => section.id !== id),
      )
    })
  }

  /** Takes back the user's last board change; false when there's none to take back. */
  undo() {
    return this.mutations.run(() => this.undoChange())
  }

  private async undoChange() {
    const entry = this.undoStack.pop()
    if (!entry) return false
    const kept = new Set(entry.frames.map((frame) => frame.id))
    const added = this.manifest.frames.filter((frame) => !kept.has(frame.id))
    for (const [id, html] of Object.entries(entry.files)) {
      await writeFile(this.framePath(id), html)
    }
    this.setFrames(entry.frames, entry.sections, false)
    for (const id of Object.keys(entry.files)) this.queueCapture(id)
    for (const frame of added) this.captures.forget(frame.id)
    this.selection = this.selection.filter((id) => kept.has(id))
    if (this.openFrame && !kept.has(this.openFrame)) this.openFrame = null
    await Promise.all(added.map((frame) => rm(this.framePath(frame.id), { force: true })))
    await this.save()
    this.emit('change')
    return true
  }

  /** The agent changed the canvas: what the user did before it can't be undone on its own. */
  forgetUndo() {
    return this.mutations.run(async () => {
      if (!this.undoStack.length) return
      this.undoStack = []
      this.emit('change')
    })
  }

  async captureNow(id: string) {
    await this.captures.thumbnail(id, true)
  }

  thumbPath(id: string) {
    return this.captures.path(id)
  }

  // Keeping in step with the files

  private remember(files: Record<string, string> = {}) {
    this.undoStack.push({ frames: this.manifest.frames, sections: this.manifest.sections, files })
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
  }

  private setFrames(frames: BoardFrameLayout[], sections = this.manifest.sections, save = true) {
    this.manifest = { ...this.manifest, frames, sections: cleanSections(sections, frames) }
    this.manifestRevision++
    if (save) this.scheduleSave(0)
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
    for (const frame of this.manifest.frames)
      if (!files.has(frame.id)) this.captures.forget(frame.id)
    this.manifest = {
      ...this.manifest,
      frames,
      sections: cleanSections(this.manifest.sections, frames),
    }
    this.manifestRevision++
    // Undoing the user's earlier layout would now take these frames off the board too.
    this.undoStack = []
    this.selection = this.selection.filter((id) => files.has(id))
    if (this.openFrame && !files.has(this.openFrame)) this.openFrame = null
    await this.save()
    return true
  }

  private watch() {
    const onRoot = (file: string | null) => {
      if (file === BOARD_MANIFEST) {
        this.settle('manifest', () => this.onManifestFile())
        return
      }
      // Undoing a turn can put the whole frames folder back.
      if (!file || file === FRAMES_DIR) this.settle('frames', () => this.resync())
      const path = file?.replaceAll('\\', '/')
      if (path?.startsWith(`${FRAMES_DIR}/`) && path.endsWith('.html')) {
        const id = path.slice(FRAMES_DIR.length + 1, -'.html'.length)
        if (isFrameId(id)) {
          this.settle(`frame:${id}`, () => this.onFrameFile(id))
          return
        }
      }
      if (!file || isBoardAsset(file))
        this.settle('assets', async () => {
          if (await this.captures.invalidateAssets())
            for (const frame of this.frames) this.emit('frameChanged', frame.id)
        })
    }
    try {
      const watcher = watch(this.root, { recursive: true }, (_event, file) => onRoot(file))
      watcher.on('error', (error) => console.error('[gui] canvas watcher failed', error))
      this.watchers.push(watcher)
    } catch (error) {
      console.error('[gui] could not watch the canvas', error)
    }
  }

  private settle(key: string, run: () => Promise<void>) {
    if (this.disposed) return
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        if (!this.disposed)
          this.mutations
            .run(run)
            .catch((error: unknown) => console.error('[gui] canvas sync failed', error))
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
    // A watcher may fire between our atomic rename and the writer's successful marker.
    await this.writer.idle().catch(() => undefined)
    const revision = this.manifestRevision
    const writtenGeneration = this.writer.generation
    const text = await readFile(join(this.root, BOARD_MANIFEST), 'utf8').catch(() => null)
    await this.writer.idle().catch(() => undefined)
    if (revision !== this.manifestRevision || writtenGeneration !== this.writer.generation) {
      this.settle('manifest', () => this.onManifestFile())
      return
    }
    if (text === null) {
      this.writer.invalidate()
      await this.save()
      return
    }
    const next = parseManifest(text, this.manifest.name)
    if (this.writer.owns(next)) return
    const before = new Map(this.manifest.frames.map((frame) => [frame.id, frame]))
    this.manifest = { ...next, camera: this.manifest.camera }
    this.manifestRevision++
    this.writer.observe(next)
    this.undoStack = []
    await this.syncFrames()
    await this.save()
    for (const frame of this.manifest.frames) {
      const previous = before.get(frame.id)
      if (!previous || previous.width !== frame.width || previous.height !== frame.height)
        this.queueCapture(frame.id)
    }
    for (const id of before.keys()) if (!this.has(id)) this.captures.forget(id)
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
    if (this.disposed) return
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
    await this.writer.save(this.manifest)
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

  // Capture work is owned separately and globally bounded across boards.

  private queueCapture(id: string) {
    if (!this.port || this.disposed) return
    void this.captures.thumbnail(id)
  }

  screenshot(id: string, scale = 1): Promise<NativeImage> {
    return this.captures.screenshot(id, scale)
  }

  dispose(): Promise<void> {
    if (this.completion) return this.completion
    this.disposed = true
    for (const watcher of this.watchers) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const captures = this.captures.dispose()
    this.completion = this.mutations.close().then(async () => {
      // Accepted file mutations finish before the last manifest snapshot is acknowledged.
      try {
        await this.save()
      } finally {
        this.server?.close()
        this.server = null
        await captures
      }
    })
    return this.completion
  }
}
