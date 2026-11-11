import { MAX_PNG_BYTES } from '../shared/bounded'

/**
 * The most bytes an image Gui hands the agent may take, before base64. Claude refuses a
 * tool result whose image is over 5 MB as base64; this stays under it with room to spare.
 */
export const MAX_AGENT_IMAGE_BYTES = MAX_PNG_BYTES

/** The part of Electron's NativeImage that encoding needs (tests pass their own). */
export interface EncodableImage {
  getSize(): { width: number; height: number }
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): this
}

/** An image decoded from a capture, which may have failed to decode. */
export interface DecodedImage extends EncodableImage {
  isEmpty(): boolean
}

export interface EncodedImage {
  data: Buffer
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/** JPEG qualities tried in turn before the image is made smaller. */
const QUALITIES = [85, 70]
/** Each step down shrinks both sides by this much; text stays readable for a few steps. */
const SHRINK = 0.75

/**
 * `image` encoded within `max` bytes: as a PNG when that fits (and `png` allows it), else as a
 * JPEG, at lower quality and then smaller until it fits.
 */
export function encodeWithin(
  image: EncodableImage,
  { png = true, max = MAX_AGENT_IMAGE_BYTES }: { png?: boolean; max?: number } = {},
): EncodedImage {
  let current = image
  if (png) {
    const data = current.toPNG()
    if (data.length <= max) return { data, mimeType: 'image/png', ...current.getSize() }
  }
  for (;;) {
    const size = current.getSize()
    for (const quality of QUALITIES) {
      const data = current.toJPEG(quality)
      if (data.length <= max) return { data, mimeType: 'image/jpeg', ...size }
    }
    // Nothing smaller left to try: the last JPEG is as small as this gets.
    if (size.width <= 64 || size.height <= 64)
      return { data: current.toJPEG(QUALITIES.at(-1) ?? 70), mimeType: 'image/jpeg', ...size }
    current = current.resize({
      width: Math.max(1, Math.round(size.width * SHRINK)),
      height: Math.max(1, Math.round(size.height * SHRINK)),
      quality: 'good',
    })
  }
}

/** How many bytes base64 `data` decodes to. */
export const base64Bytes = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
