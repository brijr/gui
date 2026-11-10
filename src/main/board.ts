import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { app, protocol } from 'electron'
import {
  BOARD_MANIFEST,
  type BoardManifest,
  FRAMES_DIR,
  isFrameId,
  parseManifest,
} from '../shared/board'
import type { RecentBoard } from '../shared/types'
import { writeFileAtomic } from './atomic-file'
import { shadowRepoName } from './checkpoints'
import { claimedHistoryFiles, historyFile } from './history'
import { recordingProjectKey } from './recordings'
import { trust } from './trust'

/**
 * Canvases live in Gui's own data, a folder each: `canvases/<id>/` with its manifest
 * (`canvas.json`), its frames (`frames/<frame>.html`) and whatever they share (`assets/`).
 * Being real folders, a canvas's chat history, checkpoints and Ask/Auto key off its path
 * like a project's do.
 */
export const boardsDir = () => join(app.getPath('userData'), 'canvases')

const BOARD_ID = /^[a-z0-9]{12}$/

export function isBoardId(value: unknown): value is string {
  return typeof value === 'string' && BOARD_ID.test(value)
}

export const boardRoot = (id: string) => join(boardsDir(), id)

/** The canvas a folder is, when it's one of Gui's; null for any other folder. */
export function boardIdOf(root: string): string | null {
  const dir = resolve(boardsDir())
  const path = resolve(root)
  if (!path.startsWith(dir + sep)) return null
  const id = path.slice(dir.length + 1)
  return isBoardId(id) ? id : null
}

export async function readManifest(root: string, fallbackName = 'Untitled canvas') {
  const text = await readFile(join(root, BOARD_MANIFEST), 'utf8').catch(() => null)
  return parseManifest(text, fallbackName)
}

export function writeManifest(root: string, manifest: BoardManifest) {
  return writeFileAtomic(join(root, BOARD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** A new, empty canvas, named for when it was made until someone names it. */
export async function createBoard(): Promise<string> {
  const id = randomBytes(6).toString('hex')
  const root = boardRoot(id)
  await mkdir(join(root, FRAMES_DIR), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'assets'), { mode: 0o700 })
  await writeManifest(root, {
    version: 1,
    name: 'Untitled canvas',
    createdAt: Date.now(),
    frames: [],
    sections: [],
    camera: null,
  })
  // Gui made it and only Gui and the agent write in it, like a new project.
  await trust(root).catch((error: unknown) => console.error('[gui] failed to trust canvas', error))
  return root
}

/** Every canvas, last edited first. */
export async function listBoards(): Promise<RecentBoard[]> {
  const ids = (await readdir(boardsDir()).catch(() => [] as string[])).filter(isBoardId)
  const boards = await Promise.all(
    ids.map(async (id): Promise<RecentBoard | null> => {
      const root = boardRoot(id)
      try {
        const [manifest, info] = await Promise.all([
          readManifest(root),
          stat(join(root, BOARD_MANIFEST)),
        ])
        const frames = await readdir(join(root, FRAMES_DIR)).catch(() => [] as string[])
        const newest = await Promise.all(
          frames.map((file) =>
            stat(join(root, FRAMES_DIR, file)).then(
              (frame) => frame.mtimeMs,
              () => 0,
            ),
          ),
        )
        return {
          id,
          name: manifest.name,
          frames: manifest.frames.length,
          editedAt: Math.max(info.mtimeMs, ...newest),
        }
      } catch {
        return null
      }
    }),
  )
  return boards
    .filter((board): board is RecentBoard => board !== null)
    .sort((a, b) => b.editedAt - a.editedAt)
}

/** Entries in `dir` that are `name` itself or start with it and then `.` or `-`. */
async function removeNamed(dir: string, name: string, keep: ReadonlySet<string> = new Set()) {
  const entries = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry === name || entry.startsWith(`${name}.`) || entry.startsWith(`${name}-`)) &&
          !keep.has(join(dir, entry)),
      )
      .map((entry) => rm(join(dir, entry), { recursive: true, force: true })),
  )
}

/**
 * Gone for good: its frames, the thumbnails Gui kept of them, and what Gui kept for its chats,
 * as for a project folder: chat history and archive, checkpoints and recordings. A tab must not
 * have it open (they're keyed off its path, and a live chat writes them).
 */
export async function deleteBoard(id: string) {
  if (!isBoardId(id)) return
  const root = boardRoot(id)
  const real = await realpath(root).catch(() => root)
  const data = app.getPath('userData')
  // The chat file, numbered ones beside it, their summaries and the archive folder.
  const chats = await historyFile(root)
  await rm(root, { recursive: true, force: true })
  await Promise.all([
    rm(thumbsDir(id), { recursive: true, force: true }),
    removeNamed(join(data, 'chats'), basename(chats, '.json'), new Set(claimedHistoryFiles())),
    // Its shadow repo and the marker of when it was last pruned.
    removeNamed(join(data, 'checkpoints'), shadowRepoName(real)),
    rm(join(data, 'recordings', recordingProjectKey(root)), { recursive: true, force: true }),
  ])
}

/** Where a canvas's frame thumbnails are kept: Gui's, outside the folder the agent works in. */
export const thumbsDir = (id: string) => join(app.getPath('userData'), 'canvas-thumbnails', id)

/**
 * Where the board loads a frame's thumbnail from: `${thumbsUrl(id)}/<frame id>?v=<version>`,
 * or `<frame id>.small` for its zoomed-out copy.
 */
export const thumbsUrl = (id: string) => `gui-thumb://${id}`

/**
 * Serves frame thumbnails to Gui's own pages, `gui-thumb://<canvas>/<frame>`. Only Gui's UI
 * session has the protocol; previewed pages can't read them. So any origin may read one's
 * pixels (CORS): the only pages that can ask are Gui's own.
 */
export function registerThumbProtocol() {
  protocol.handle('gui-thumb', async (request) => {
    try {
      const url = new URL(request.url)
      const name = url.pathname.slice(1)
      const frame = name.endsWith('.small') ? name.slice(0, -'.small'.length) : name
      if (!isBoardId(url.hostname) || !isFrameId(frame)) return new Response(null, { status: 404 })
      const dir = thumbsDir(url.hostname)
      // A thumbnail made before small copies existed has none until it's made again.
      const image = await readFile(join(dir, `${name}.jpg`)).catch(() =>
        readFile(join(dir, `${frame}.jpg`)),
      )
      return new Response(image, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
