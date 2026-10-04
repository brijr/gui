import { nativeImage } from 'electron'

const MAX_WIDTH = 320
const MAX_HEIGHT = 240

/** A small JPEG data URL for showing a change at a glance; null when the image can't be read. */
export function thumbnail(image: string | { data: string; mimeType: string } | null) {
  if (!image) return null
  const dataUrl = typeof image === 'string' ? image : `data:${image.mimeType};base64,${image.data}`
  const source = nativeImage.createFromDataURL(dataUrl)
  if (source.isEmpty()) return null
  const { width, height } = source.getSize()
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height)
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
