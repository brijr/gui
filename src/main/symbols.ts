import { type NativeImage, nativeImage } from 'electron'
import { SYMBOLS, type SymbolImages } from '../shared/symbols'

let images: SymbolImages | undefined

const POINT_SIZE = 48

const draw = (name: string) =>
  nativeImage.createFromNamedImage(name, { pointSize: POINT_SIZE, weight: 'regular' })

/**
 * Rasterize once at 3× toolbar size; CSS masks give every symbol the control's text color.
 * Symbols come out as wide or tall as they're drawn, so each carries its size against a plain
 * circle at the same point size: icons then share one size, as they do in a Mac toolbar,
 * rather than each being stretched to fill a square.
 */
export function getSymbols(): SymbolImages {
  if (images) return images
  images = {}
  if (process.platform !== 'darwin') return images
  const circle = draw('circle').getSize()
  const unit = circle.height || POINT_SIZE
  const fraction = (pixels: number) => Math.round((pixels / unit) * 1000) / 1000
  for (const name of new Set(Object.values(SYMBOLS))) {
    const image = draw(name)
    if (image.isEmpty()) continue
    const { width, height } = image.getSize()
    images[name] = {
      src: withoutFaintLayer(image).toDataURL(),
      width: fraction(width),
      height: fraction(height),
    }
  }
  return images
}

/** Alpha of the see-through layer some symbols draw under their outline, and the band around it. */
const FAINT = { low: 48, high: 112 }

/**
 * Some symbols (display, iphone, ipad, laptopcomputer) fill their screen with a see-through
 * second layer. As a mask it reads as a grey screen, heavier than the outline icons beside
 * it, so where much of a symbol sits at that faint alpha, it's taken out: the outline keeps
 * its full strength, and its edges fade to nothing as before.
 */
function withoutFaintLayer(image: NativeImage): NativeImage {
  const pixels = image.toBitmap()
  let shown = 0
  let faint = 0
  for (let i = 3; i < pixels.length; i += 4) {
    const alpha = pixels[i]
    if (alpha === 0) continue
    shown++
    if (alpha >= FAINT.low && alpha < FAINT.high) faint++
  }
  if (faint < shown * 0.25) return image
  const floor = FAINT.high
  for (let i = 3; i < pixels.length; i += 4) {
    pixels[i] = Math.round((Math.max(0, pixels[i] - floor) * 255) / (255 - floor))
  }
  // Premultiplied BGRA: color channels scale with their alpha.
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]
    pixels[i] = Math.min(pixels[i], alpha)
    pixels[i + 1] = Math.min(pixels[i + 1], alpha)
    pixels[i + 2] = Math.min(pixels[i + 2], alpha)
  }
  const size = image.getSize()
  const scaleFactor = Math.round(Math.sqrt(pixels.length / 4 / (size.width * size.height))) || 1
  return nativeImage.createFromBitmap(pixels, {
    width: size.width * scaleFactor,
    height: size.height * scaleFactor,
    scaleFactor,
  })
}
