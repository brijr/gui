import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dialog, type NativeImage } from 'electron'
import type { ImageAttachment, PreviewFrame, ProjectInfo, Rect } from '../shared/types'
import type { DeveloperToolsStatus } from './developer-tools'
import type { TabState } from './tab-host'

const ATTACH_EDGE = 1568
const ATTACH_THUMBNAIL_EDGE = 160
const ATTACH_MAX_PNG_BYTES = 3 * 1024 * 1024

/** A source path the inspector found, relative to the repo, as a file to edit; null outside it. */
export function sourceInProject(root: string, file: string) {
  const path = resolve(root, file)
  const inside = relative(root, path)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
  return inside.split(sep).includes('node_modules') ? null : path
}

export function appRoot(project: ProjectInfo) {
  return project.appDir ? join(project.root, project.appDir) : project.root
}

/** Commands that run on Node.js. */
const NODE_TOOLS = new Set(['node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack'])

/**
 * Whether getting the project going needs Node.js: anything Gui detects or installs does,
 * and so does an empty project the agent will build. A start command of the user's own that
 * runs something else (`python manage.py runserver`), with nothing to install, doesn't.
 */
export function needsNode(project: ProjectInfo, installs: unknown[]) {
  if (!project.custom || installs.length > 0) return true
  const words = project.custom.command.trim().split(/\s+/)
  while (words[0] && /^\w+=/.test(words[0])) words.shift()
  return NODE_TOOLS.has(words[0] ?? '')
}

export function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** `rect` (window coordinates) in the canvas's own. */
export function inCanvas(rect: Rect, canvas: Rect): Rect {
  return { ...rect, x: rect.x - canvas.x, y: rect.y - canvas.y }
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Where the before image sits in a larger after image, when the element changed size
 * (page coordinates in, the after image's own coordinates out). Null when both show the
 * same area, or the after image doesn't cover the before one.
 */
export function previewFrame(before: Rect, after: Rect): PreviewFrame | null {
  const same =
    Math.abs(before.width - after.width) <= 1 && Math.abs(before.height - after.height) <= 1
  const covers =
    before.x >= after.x - 1 &&
    before.y >= after.y - 1 &&
    before.x + before.width <= after.x + after.width + 1 &&
    before.y + before.height <= after.y + after.height + 1
  if (same || !covers) return null
  return {
    width: after.width,
    height: after.height,
    before: { ...before, x: before.x - after.x, y: before.y - after.y },
  }
}

/** "<project> 2026-10-03 at 14.05.09", the way macOS names screenshots. */
export function screenshotName(project: string, date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  const base =
    project
      .replace(/[\p{Cc}/\\:]/gu, '-')
      .trim()
      .slice(0, 100) || 'Screenshot'
  return `${base} ${day} at ${time}`
}

/**
 * A screenshot as the composer attaches images: downscaled for the agent, a PNG unless
 * that's photo-sized, plus a small thumbnail for the transcript.
 */
export function chatImage(source: NativeImage, name: string): ImageAttachment {
  const image = fitImage(source, ATTACH_EDGE)
  const png = image.toPNG()
  const jpeg = png.length > ATTACH_MAX_PNG_BYTES
  const thumbnail = fitImage(source, ATTACH_THUMBNAIL_EDGE).toPNG()
  return {
    name: `${name}.${jpeg ? 'jpg' : 'png'}`,
    mimeType: jpeg ? 'image/jpeg' : 'image/png',
    data: (jpeg ? image.toJPEG(85) : png).toString('base64'),
    thumbnail: `data:image/png;base64,${thumbnail.toString('base64')}`,
  }
}

/** Scales an image down so its long side is at most `edge`. */
export function fitImage(image: NativeImage, edge: number) {
  const { width, height } = image.getSize()
  const scale = Math.min(1, edge / Math.max(width, height))
  if (scale === 1) return image
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  })
}

/** What the window says about Apple's developer tools: nothing until they're found missing. */
export function shownTools(status: DeveloperToolsStatus): TabState['developerTools'] {
  return status === 'missing' || status === 'installing' ? status : null
}

export function frameError(error: unknown) {
  dialog.showErrorBox(
    "Couldn't export the frame",
    error instanceof Error ? error.message : String(error),
  )
}
