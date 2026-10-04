import type { ImageAttachment } from '../../../shared/types'

/** Main accepts at most this many images per message. */
export const MAX_IMAGES = 6
/** Claude's recommended long edge; bigger images only cost more and get downscaled anyway. */
const MAX_EDGE = 1568
const THUMBNAIL_EDGE = 160
/** Larger files aren't decoded at all: a huge image could exhaust the renderer's memory. */
const MAX_FILE_BYTES = 20 * 1024 * 1024
/**
 * A downscaled PNG this big is photo-like; as a JPEG it stays well under agents'
 * per-image limits (Claude's is 5 MB) and costs the same tokens.
 */
const MAX_PNG_BYTES = 3 * 1024 * 1024

/** An image attached to the draft; `id` only keys it in the composer and isn't sent. */
export interface DraftImage extends ImageAttachment {
  id: string
}

/** A file that can't be attached; the message is shown in the composer as is. */
export class ImageError extends Error {}

const isImageFile = (file: File) => file.type.startsWith('image/')

/** Image files dropped or pasted along with other content; the rest is reported, not attached. */
export function imageFiles(files: Iterable<File>) {
  const images: File[] = []
  let rejected: string | null = null
  for (const file of files) {
    if (isImageFile(file)) images.push(file)
    else rejected ??= `${file.name || 'That file'} isn't an image.`
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
 */
export async function prepareImage(file: File): Promise<DraftImage> {
  const name = (file.name || 'image').slice(0, 200)
  if (!isImageFile(file)) throw new ImageError(`${name} isn't an image.`)
  if (file.size > MAX_FILE_BYTES) throw new ImageError(`${name} is over 20 MB.`)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageError(`Couldn't read ${name}. Try a PNG or JPEG.`)
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
    return { id: crypto.randomUUID(), name, mimeType, data, thumbnail }
  } finally {
    bitmap.close()
  }
}

/** Off the main thread where Chromium can: OffscreenCanvas encodes asynchronously. */
function encode(bitmap: ImageBitmap, edge: number, type: string) {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageError("Couldn't process the image.")
  // JPEG has no alpha: transparent areas would turn black.
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas.convertToBlob({ type, quality: type === 'image/png' ? undefined : 0.85 })
}

/** The renderer's CSP blocks fetching data: and blob: URLs, so read the blob directly. */
function dataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new ImageError("Couldn't process the image."))
    reader.readAsDataURL(blob)
  })
}
