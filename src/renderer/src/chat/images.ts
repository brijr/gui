import {
  MAX_ASSET_BYTES,
  MAX_ASSET_EDGE,
  MAX_ASSET_PNG_BYTES,
  MAX_PNG_BYTES,
} from '../../../shared/bounded'
import type { ImageAsset, ImageAttachment } from '../../../shared/types'

/** Claude's recommended long edge; bigger images only cost more and get downscaled anyway. */
const MAX_EDGE = 1568
const THUMBNAIL_EDGE = 160
/** Larger files aren't decoded at all: a huge image could exhaust the renderer's memory. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

/** An image attached to the draft; `id` only keys it in the composer and isn't sent. */
export interface DraftImage extends ImageAttachment {
  id: string
  size?: number
  /**
   * In a canvas's chat, the full-quality copy main saves to its assets/ when the message is
   * sent. Kept as a blob until then: a draft image removed before sending leaves nothing.
   */
  asset?: Blob
}

/** A file that can't be attached; the message is shown in the composer as is. */
export class ImageError extends Error {}

const isImageFile = (file: File) => file.type.startsWith('image/')

export function shortName(name: string) {
  return name.length <= 32 ? name : `${name.slice(0, 18)}…${name.slice(-12)}`
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Image files dropped or pasted along with other content; the rest is reported, not attached. */
export function imageFiles(files: Iterable<File>) {
  const images: File[] = []
  let rejected: string | null = null
  for (const file of files) {
    if (isImageFile(file)) images.push(file)
    else rejected ??= `${file.name || 'That file'} isn’t an image.`
  }
  return { images, rejected }
}

/**
 * Downscales a pasted, dropped or picked image for the agent and makes its transcript
 * thumbnail. Always re-encoded, which also strips metadata such as location.
 *
 * JPEGs stay JPEG (0.85): they're photos and already lossy. Everything else becomes PNG,
 * which keeps screenshots' text and edges crisp and design exports' transparency, unless
 * that PNG is photo-sized, in which case it's a JPEG on white. GIFs keep their first frame.
 *
 * `asset`, in a canvas's chat: also a full-quality copy for frames to use (`DraftImage.asset`),
 * made here from the same decode. It's encoded in the renderer because OffscreenCanvas does it
 * off the main thread, where main's encoder would hold the whole app, and the decode already
 * applied the photo's orientation. Without it, if that copy can't be made, the image still
 * attaches.
 */
export async function prepareImage(file: File, asset = false): Promise<DraftImage> {
  const name = (file.name || 'image').slice(0, 200)
  if (!isImageFile(file)) throw new ImageError(`${name} isn’t an image.`)
  if (file.size > MAX_FILE_BYTES) throw new ImageError(`${name} is over 20 MB.`)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageError(`Couldn’t read ${name}. Try a PNG or JPEG.`)
  }
  try {
    let full = await encode(
      bitmap,
      MAX_EDGE,
      file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    )
    if (full.type === 'image/png' && full.size > MAX_PNG_BYTES) {
      full = await encode(bitmap, MAX_EDGE, 'image/jpeg')
    }
    // WebP keeps thumbnails tiny with transparency; Chromium falls back to PNG if it can't.
    const thumbnail = await dataUrl(await encode(bitmap, THUMBNAIL_EDGE, 'image/webp'))
    const mimeType = full.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    const data = (await dataUrl(full)).split(',')[1] ?? ''
    const copy = asset ? await assetCopy(bitmap, file.type).catch(() => null) : null
    return {
      id: crypto.randomUUID(),
      size: file.size,
      name,
      mimeType,
      data,
      thumbnail,
      ...(copy ? { asset: copy } : {}),
    }
  } finally {
    bitmap.close()
  }
}

/**
 * The copy saved to a canvas's assets/: full resolution up to MAX_ASSET_EDGE, re-encoded so
 * no metadata (location, camera) comes along. The same choices as the agent's copy: JPEGs
 * stay JPEG, now at 0.92; screenshots and transparent images are PNG unless photo-sized.
 * Null when it would be too big for main to take.
 */
async function assetCopy(bitmap: ImageBitmap, type: string): Promise<Blob | null> {
  let copy = await encode(
    bitmap,
    MAX_ASSET_EDGE,
    type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    ASSET_QUALITY,
  )
  if (copy.type === 'image/png' && copy.size > MAX_ASSET_PNG_BYTES) {
    copy = await encode(bitmap, MAX_ASSET_EDGE, 'image/jpeg', ASSET_QUALITY)
  }
  if (copy.type !== 'image/jpeg' && copy.type !== 'image/png') return null
  return copy.size <= MAX_ASSET_BYTES ? copy : null
}

const ASSET_QUALITY = 0.92

/** What the composer sends for a draft image's asset copy: bytes cross IPC without base64. */
export async function sentAsset(blob: Blob): Promise<ImageAsset> {
  return {
    mimeType: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    bytes: new Uint8Array(await blob.arrayBuffer()),
  }
}

/** Off the main thread where Chromium can: OffscreenCanvas encodes asynchronously. */
function encode(bitmap: ImageBitmap, edge: number, type: string, quality = 0.85) {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageError('Couldn’t process the image.')
  // JPEG has no alpha: transparent areas would turn black.
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas.convertToBlob({ type, quality: type === 'image/png' ? undefined : quality })
}

/** The renderer's CSP blocks fetching data: and blob: URLs, so read the blob directly. */
function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new ImageError('Couldn’t process the image.'))
    reader.readAsDataURL(blob)
  })
}
