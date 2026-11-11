import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Inspector } from '../src/main/inspector'
import { placePreview, ViewportEmulation, zoomed } from '../src/main/viewport'
import { FRAME_LABEL_HEIGHT, FRAME_MARGIN } from '../src/shared/layout'
import { frameLabel, frameViewport, isCustomViewport, viewportSpec } from '../src/shared/types'

const area = (width: number, height: number) => ({ x: 0, y: 0, width, height })
/** The room a device frame has in `area`, less its margin and label. */
const room = (width: number, height: number) => ({
  width: width - FRAME_MARGIN * 2,
  height: height - FRAME_MARGIN * 2 - FRAME_LABEL_HEIGHT,
})

describe('a canvas frame at its own size', () => {
  test('device sizes and widths open as that device; any other size as its own', () => {
    expect(frameViewport({ width: 390, height: 844 })).toBe('mobile')
    expect(frameViewport({ width: 1440, height: 900 })).toBe('laptop')
    // A long page at a device's width scrolls in that device, as before.
    expect(frameViewport({ width: 390, height: 2400 })).toBe('mobile')
    expect(frameViewport({ width: 1080, height: 1080 })).toBe('1080x1080')
    expect(frameViewport({ width: 300, height: 250 })).toBe('300x250')
    // A story is a poster; a longer page at another width opens laptop-high and scrolls.
    expect(frameViewport({ width: 1080, height: 1920 })).toBe('1080x1920')
    expect(frameViewport({ width: 1280, height: 4000 })).toBe('1280x900')
    expect(isCustomViewport('1200x630')).toBe(true)
    expect(isCustomViewport('mobile')).toBe(false)
    expect(isCustomViewport('12x')).toBe(false)
  })

  test('its spec and label name the size', () => {
    expect(viewportSpec('1080x1080')).toEqual({
      id: '1080x1080',
      name: '1080 × 1080',
      size: { width: 1080, height: 1080 },
      mobile: false,
    })
    expect(frameLabel('1080x1080', 1)).toEqual({ name: '1080 × 1080', detail: '' })
    expect(frameLabel('1080x1080', 0.5)).toEqual({ name: '1080 × 1080', detail: ' · 50%' })
    // Devices are labelled as before.
    expect(frameLabel('laptop', 1)).toEqual({ name: 'Laptop', detail: ' · 1440 × 900' })
  })

  test('lays out at exactly its size, drawn smaller to fit and never larger', () => {
    // Fits: drawn at 100%, centered under its label.
    const small = placePreview('300x250', area(1200, 800))
    expect(small.emulation).toEqual({ width: 300, height: 250, scale: 1, mobile: false })
    expect(small.bounds).toEqual({
      x: 450,
      y: Math.round(FRAME_LABEL_HEIGHT + (800 - FRAME_LABEL_HEIGHT - 250) / 2),
      width: 300,
      height: 250,
    })
    // Too large for the window: the page keeps its CSS size, drawn at the scale that fits.
    const square = placePreview('1080x1080', area(1200, 800))
    const fit = Math.floor((room(1200, 800).height / 1080) * 1000) / 1000
    expect(square.emulation).toEqual({ width: 1080, height: 1080, scale: fit, mobile: false })
    expect(square.bounds.width).toBe(Math.round(1080 * fit))
    expect(square.bounds.height).toBe(Math.round(1080 * fit))
    // A wide one is held by the width.
    const og = placePreview('1200x630', area(1000, 900))
    expect(og.emulation?.scale).toBe(Math.floor((room(1000, 900).width / 1200) * 1000) / 1000)
    expect(og.emulation).toMatchObject({ width: 1200, height: 630 })
  })

  test('zooms like a device frame: down to 25%, up to fitting again', () => {
    const window = area(1200, 800)
    // Fitting is 67.4%: a step out is Chrome's 67%, then 50%.
    const out = zoomed('1080x1080', window, null, -1)
    expect(out).toBe(0.67)
    expect(zoomed('1080x1080', window, 0.67, -1)).toBe(0.5)
    expect(placePreview('1080x1080', window, 0.5).emulation?.scale).toBe(0.5)
    expect(zoomed('1080x1080', window, 0.67, 1)).toBeNull()
    expect(zoomed('1080x1080', window, null, 1)).toBeUndefined()
    expect(zoomed('1080x1080', window, 0.5, 0)).toBeNull()
  })
})

/** A stand-in inspector: its lock runs one section at a time; commands are recorded. */
function standInInspector() {
  const sent: { method: string; params?: Record<string, unknown> }[] = []
  let tail: Promise<unknown> = Promise.resolve()
  const inspector = Object.assign(new EventEmitter(), {
    exclusive: <T>(fn: () => Promise<T>) => {
      const run = tail.then(fn)
      tail = run.catch(() => undefined)
      return run
    },
    command: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params })
      return {}
    },
  })
  const idle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { inspector: inspector as unknown as Inspector, emitter: inspector, sent, idle }
}

describe("the preview's emulated viewport", () => {
  test('sends the frame again after a capture may have left the page at its own scale', async () => {
    const { inspector, emitter, sent, idle } = standInInspector()
    const emulation = new ViewportEmulation(inspector)
    const laptop = placePreview('laptop', area(1200, 800)).emulation
    emulation.set(laptop)
    await idle()
    const overrides = () => sent.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    expect(overrides()).toHaveLength(1)
    // Unchanged, nothing is sent.
    emulation.set(laptop)
    await idle()
    expect(overrides()).toHaveLength(1)
    // A capture cut short by a reload left Chromium drawing the page at its clip's scale: the
    // laptop frame goes back, though it's what was last sent.
    emitter.emit('emulationLost')
    await idle()
    expect(overrides()).toHaveLength(2)
    expect(overrides()[1]?.params).toMatchObject({
      width: 1440,
      height: 900,
      scale: laptop?.scale,
      dontSetVisibleSize: true,
    })
    emulation.dispose()
  })

  test('Desktop at 100% clears what a capture cut short left', async () => {
    const { inspector, emitter, sent, idle } = standInInspector()
    const emulation = new ViewportEmulation(inspector)
    emulation.set(null)
    await idle()
    expect(sent).toHaveLength(0)
    emitter.emit('emulationLost')
    await idle()
    expect(sent.map((c) => c.method)).toEqual(['Emulation.clearDeviceMetricsOverride'])
    emulation.dispose()
  })
})
