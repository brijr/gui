import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { CaptureInterrupted } from '../src/main/errors'
import { awaitCapture } from '../src/main/page-capture'

// Chromium draws the page at a capture's clip and scale until the capture comes back; one the
// page reloads under never does. The capture gives up then, and the viewport is sent again.

/** A preview whose capture waits until `answer` is called. */
function standInCapture() {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  let answer: (data: string) => void = () => {}
  const sent = new Promise<{ data: string }>((resolve) => {
    answer = (data) => resolve({ data })
  })
  let lost = 0
  const shot = awaitCapture(wc as unknown as WebContents, sent, 15_000, () => lost++)
  return { wc, shot, answer, lost: () => lost }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a page capture', () => {
  test('comes back as Chromium answers it, leaving the emulation alone', async () => {
    const { wc, shot, answer, lost } = standInCapture()
    answer('png')
    expect(await shot).toEqual({ data: 'png' })
    expect(lost()).toBe(0)
    // Done with the page's events.
    expect(wc.listenerCount('did-navigate')).toBe(0)
    expect(wc.listenerCount('render-process-gone')).toBe(0)
  })

  test('a reload under it ends it at once and has the viewport sent again', async () => {
    const { wc, shot, answer, lost } = standInCapture()
    const failed = shot.catch((error: unknown) => error)
    wc.emit('did-navigate', {}, 'http://localhost:4322/')
    expect(await failed).toBeInstanceOf(CaptureInterrupted)
    expect(lost()).toBe(1)
    // Should Chromium answer after all, it put back the emulation it started with: again.
    answer('late')
    await tick()
    expect(lost()).toBe(2)
  })

  test('so does the page process going away', async () => {
    const { wc, shot, lost } = standInCapture()
    const failed = shot.catch((error: unknown) => error)
    wc.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(await failed).toBeInstanceOf(CaptureInterrupted)
    expect(lost()).toBe(1)
  })
})
