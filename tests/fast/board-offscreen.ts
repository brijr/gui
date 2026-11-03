// Run separately so Electron stubs cannot contaminate the rest of the fast suite.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

let readiness: Promise<unknown> | null = null
let failedNavigation = false
/** The page's script never ends: loading never finishes and nothing else it's asked runs. */
let stuck: 'loading' | 'loaded' | null = null
const events: string[] = []
const never = new Promise<never>(() => undefined)
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
  crashed = false
  async loadURL(url: string) {
    events.push(`load:${url}`)
    if (failedNavigation && url !== 'about:blank') throw new Error('ERR_CONNECTION_REFUSED')
    if (stuck === 'loading' && url !== 'about:blank') return never
    this.url = url
  }
  executeJavaScript(script: string) {
    if (script === '0') return stuck ? never : Promise.resolve(0)
    if (stuck === 'loaded') return never
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
  forcefullyCrashRenderer() {
    this.crashed = true
    events.push('crash')
  }
  isDestroyed() {
    return false
  }
}
class Window {
  static all: Window[] = []
  webContents = new Contents()
  destroyed = false
  options: { webPreferences: Record<string, unknown> }
  constructor(options: { webPreferences: Record<string, unknown> }) {
    this.options = options
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
class Session extends EventEmitter {
  partition = ''
  denied = 0
  setPermissionRequestHandler(
    handler: (wc: unknown, p: string, done: (ok: boolean) => void) => void,
  ) {
    handler(null, 'media', (ok) => {
      if (!ok) this.denied++
    })
  }
  setPermissionCheckHandler(handler: () => boolean) {
    if (!handler()) this.denied++
  }
  setDevicePermissionHandler() {}
}
const sessions: Session[] = []
mock.module('electron', () => ({
  BrowserWindow: Window,
  session: {
    fromPartition: (partition: string) => {
      const value = Object.assign(new Session(), { partition })
      sessions.push(value)
      return value
    },
  },
}))
const { OffscreenBoardRenderer } = await import('../../src/main/board-capture-renderer')
const { UnresponsiveFrameError } = await import('../../src/main/board-capture')
const renderer = new OffscreenBoardRenderer()
const frame = { id: 'frame', name: 'Frame', x: 0, y: 0, width: 400, height: 300 }
const url = 'http://127.0.0.1:1234/token/frames/frame.html'
const control = new AbortController()
const first = await renderer.render(frame, url, 1, control.signal, 3000)
assert.ok(first)
assert.equal(Window.all.length, 1)
// Frames render apart from the user's previews: in memory, with no dialogs or permissions.
const preferences = Window.all[0].options.webPreferences
assert.equal(preferences.disableDialogs, true)
assert.equal(preferences.partition, undefined)
assert.equal(sessions.length, 1)
assert.equal(preferences.session, sessions[0])
assert.ok(!sessions[0].partition.startsWith('persist:'))
assert.equal(sessions[0].denied, 2)
assert.equal(Window.all[0].webContents.url, 'about:blank')
assert.equal(Window.all[0].webContents.painting, false)
assert.ok(events.indexOf(`load:${url}`) < events.indexOf('capture'))
assert.ok(events.indexOf('capture') < events.indexOf('load:about:blank'))
await renderer.render(frame, url, 1, control.signal, 3000)
assert.equal(Window.all.length, 1, 'Same-scale captures reuse an unloaded worker')
await renderer.render(frame, url, 2, control.signal, 3000)
assert.equal(Window.all.length, 2)
assert.equal(Window.all[0].destroyed, true, 'Changing scale does not accumulate idle windows')

failedNavigation = true
const capturesBeforeFailure = events.filter((event) => event === 'capture').length
assert.equal(await renderer.render(frame, url, 2, control.signal, 3000), null)
assert.equal(events.filter((event) => event === 'capture').length, capturesBeforeFailure)
assert.equal(Window.all[1].webContents.url, 'about:blank')
assert.equal(Window.all[1].webContents.painting, false)
failedNavigation = false

readiness = new Promise(() => undefined)
const pending = new AbortController()
const started = renderer.render(frame, url, 2, pending.signal, 3000)
await Promise.resolve()
await Promise.resolve()
pending.abort()
assert.equal(await started, null)
assert.equal(Window.all[1].webContents.url, 'about:blank')
assert.equal(Window.all[1].webContents.painting, false)
readiness = null

// A page whose script never ends is stopped within seconds, not the whole load timeout, and
// the next capture gets a new worker.
for (const when of ['loading', 'loaded'] as const) {
  stuck = when
  const before = Window.all.length
  const hungAt = Date.now()
  await assert.rejects(
    renderer.render(frame, url, 2, control.signal, 3000),
    (error) => error instanceof UnresponsiveFrameError && /didn't respond/.test(error.message),
  )
  assert.ok(Date.now() - hungAt < 6000, `A page stuck while ${when} is stopped quickly`)
  const worker = Window.all[before - 1]
  assert.equal(worker.webContents.crashed, true)
  assert.equal(worker.destroyed, true)
  stuck = null
  assert.ok(await renderer.render(frame, url, 2, control.signal, 3000))
  assert.equal(Window.all.length, before + 1, 'A stuck worker is replaced, not reused')
}

renderer.dispose()
assert.equal(Window.all.at(-1)?.destroyed, true)
assert.equal(await renderer.render(frame, url, 1, control.signal, 3000), null)
assert.equal(sessions.length, 1, 'One capture session, locked down once')
console.log('Offscreen readiness, unload, painting, reuse, scale, hangs, and cancellation passed.')
