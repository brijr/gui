// Run separately so Electron stubs cannot contaminate the rest of the fast suite.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

let readiness: Promise<unknown> | null = null
let failedNavigation = false
const events: string[] = []
class Contents extends EventEmitter {
  url = ''
  painting = false
  readyCalls = 0
  startPainting() {
    this.painting = true
    events.push('start')
  }
  stopPainting() {
    this.painting = false
    events.push('stop')
  }
  stop() {}
  async loadURL(url: string) {
    events.push(`load:${url}`)
    if (failedNavigation && url !== 'about:blank') throw new Error('ERR_CONNECTION_REFUSED')
    this.url = url
  }
  executeJavaScript(script: string) {
    this.readyCalls++
    assert.ok(script.includes('document.fonts.ready'))
    assert.ok(script.includes('document.images'))
    assert.ok(script.includes('requestAnimationFrame'))
    return readiness ?? Promise.resolve()
  }
  async capturePage() {
    events.push('capture')
    return { isEmpty: () => false }
  }
  getURL() {
    return this.url
  }
  setAudioMuted() {}
  setWindowOpenHandler() {}
}
class Window {
  static all: Window[] = []
  webContents = new Contents()
  destroyed = false
  constructor() {
    Window.all.push(this)
  }
  setContentSize() {}
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    events.push('destroy')
  }
}
mock.module('electron', () => ({ BrowserWindow: Window }))
mock.module('../../src/main/storage', () => ({ PREVIEW_PARTITION: 'persist:test' }))
const { OffscreenBoardRenderer } = await import('../../src/main/board-capture-renderer')
const renderer = new OffscreenBoardRenderer()
const frame = { id: 'frame', name: 'Frame', x: 0, y: 0, width: 400, height: 300 }
const url = 'http://127.0.0.1:1234/token/frames/frame.html'
const control = new AbortController()
const first = await renderer.render(frame, url, 1, control.signal)
assert.ok(first)
assert.equal(Window.all.length, 1)
assert.equal(Window.all[0].webContents.url, 'about:blank')
assert.equal(Window.all[0].webContents.painting, false)
assert.ok(events.indexOf(`load:${url}`) < events.indexOf('capture'))
assert.ok(events.indexOf('capture') < events.indexOf('load:about:blank'))
await renderer.render(frame, url, 1, control.signal)
assert.equal(Window.all.length, 1, 'Same-scale captures reuse an unloaded worker')
await renderer.render(frame, url, 2, control.signal)
assert.equal(Window.all.length, 2)
assert.equal(Window.all[0].destroyed, true, 'Changing scale does not accumulate idle windows')

failedNavigation = true
const capturesBeforeFailure = events.filter((event) => event === 'capture').length
assert.equal(await renderer.render(frame, url, 2, control.signal), null)
assert.equal(events.filter((event) => event === 'capture').length, capturesBeforeFailure)
assert.equal(Window.all[1].webContents.url, 'about:blank')
assert.equal(Window.all[1].webContents.painting, false)
failedNavigation = false

readiness = new Promise(() => undefined)
const pending = new AbortController()
const started = renderer.render(frame, url, 2, pending.signal)
await Promise.resolve()
await Promise.resolve()
pending.abort()
assert.equal(await started, null)
assert.equal(Window.all[1].webContents.url, 'about:blank')
assert.equal(Window.all[1].webContents.painting, false)
renderer.dispose()
assert.equal(Window.all[1].destroyed, true)
assert.equal(await renderer.render(frame, url, 1, control.signal), null)
console.log('Offscreen readiness, unload, painting, reuse, scale, and cancellation passed.')
