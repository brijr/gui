import { nativeImage } from 'electron'

const MAX_WIDTH = 320
const MAX_HEIGHT = 240
/** A long strip (a heading, a nav bar) keeps at least this much of its short side, to read */
const MIN_SHORT_SIDE = 96
/** …within the pixels a 320 × 240 thumbnail has, at 2× */
const MAX_PIXELS = MAX_WIDTH * MAX_HEIGHT * 4

/** A small JPEG data URL for showing a change at a glance; null when the image can't be read. */
export function thumbnail(image: string | { data: string; mimeType: string } | null) {
  if (!image) return null
  const dataUrl = typeof image === 'string' ? image : `data:${image.mimeType};base64,${image.data}`
  const source = nativeImage.createFromDataURL(dataUrl)
  if (source.isEmpty()) return null
  const { width, height } = source.getSize()
  const fit = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height)
  const legible = MIN_SHORT_SIDE / Math.min(width, height)
  const scale = Math.min(1, Math.max(fit, legible), Math.sqrt(MAX_PIXELS / (width * height)))
  const small =
    scale < 1
      ? source.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'good',
        })
      : source
  return `data:image/jpeg;base64,${small.toJPEG(80).toString('base64')}`
}

/**
 * The color just inside an image's top-left corner (past JPEG fringing): for a crop with a
 * margin, the page around the element. As CSS, or null when the image can't be read.
 */
export function cornerColor(dataUrl: string) {
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const x = Math.min(2, width - 1)
  const y = Math.min(2, height - 1)
  // BGRA, row after row.
  const pixels = image.toBitmap()
  const at = (y * width + x) * 4
  if (at + 2 >= pixels.length) return null
  return `rgb(${pixels[at + 2]} ${pixels[at + 1]} ${pixels[at]})`
}

/** Encoded thumbnail dimensions, saved with a turn to reserve its space before loading. */
export function thumbnailSize(dataUrl: string) {
  const image = nativeImage.createFromDataURL(dataUrl)
  return image.isEmpty() ? undefined : image.getSize()
}
