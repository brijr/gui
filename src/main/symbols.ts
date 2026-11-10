import { version as kernelVersion } from 'node:os'
import { join } from 'node:path'
import { app, type NativeImage, nativeImage, screen } from 'electron'
import { SYMBOLS, type SymbolImages, type SymbolName } from '../shared/symbols'
import { cachedSymbols, symbolsKey } from './symbols-cache'

let images: Promise<SymbolImages> | undefined

/** 3× toolbar size; CSS masks give every symbol the control's text color. */
const DRAWING = { pointSize: 48, weight: 'regular' } as const

const draw = (name: string) => nativeImage.createFromNamedImage(name, DRAWING)

/**
 * Every symbol the UI uses, as images. Drawing them holds the main thread for over a tenth
 * of a second while the first window's pages load, so what was drawn is kept in Gui's data
 * folder and later launches read that instead.
 */
export function getSymbols(): Promise<SymbolImages> {
  images ??= loadSymbols()
  return images
}

async function loadSymbols(): Promise<SymbolImages> {
  if (process.platform !== 'darwin') return {}
  const names = [...new Set(Object.values(SYMBOLS))]
  const key = symbolsKey({
    system: [process.getSystemVersion(), kernelVersion()],
    versions: [app.getVersion(), process.versions.electron],
    scales: [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.scaleFactor),
    drawing: [DRAWING, FAINT],
    names,
  })
  const file = join(app.getPath('userData'), 'symbols.json')
  return cachedSymbols(file, key, names, () => drawSymbols(names))
}

/**
 * Symbols come out as wide or tall as they're drawn, so each carries its size against a plain
 * circle at the same point size: icons then share one size, as they do in a Mac toolbar,
 * rather than each being stretched to fill a square. Main goes back to its loop between
 * symbols (each takes a millisecond or two), so the pages loading are answered meanwhile.
 */
async function drawSymbols(names: readonly SymbolName[]): Promise<SymbolImages> {
  const drawn: SymbolImages = {}
  const circle = draw('circle').getSize()
  const unit = circle.height || DRAWING.pointSize
  const fraction = (pixels: number) => Math.round((pixels / unit) * 1000) / 1000
  for (const name of names) {
    await new Promise((resolve) => setImmediate(resolve))
    const image = draw(name)
    if (image.isEmpty()) continue
    const { width, height } = image.getSize()
    drawn[name] = {
      src: withoutFaintLayer(image).toDataURL(),
      width: fraction(width),
      height: fraction(height),
    }
  }
  return drawn
}

/**
 * Alpha of the see-through layer some symbols draw under their outline, the band around it,
 * and the share of a symbol that has to sit in it.
 */
const FAINT = { low: 48, high: 112, share: 0.25 }

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
  if (faint < shown * FAINT.share) return image
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
