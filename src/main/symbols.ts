import { nativeImage } from 'electron'
import { SYMBOLS, type SymbolImages } from '../shared/symbols'

let images: SymbolImages | undefined

/** Rasterize once at 3× toolbar size; CSS masks give every symbol the control's text color. */
export function getSymbols(): SymbolImages {
  if (images) return images
  images = {}
  if (process.platform !== 'darwin') return images
  for (const name of new Set(Object.values(SYMBOLS))) {
    const image = nativeImage.createFromNamedImage(name, { pointSize: 48, weight: 'regular' })
    if (!image.isEmpty()) images[name] = image.toDataURL()
  }
  return images
}
