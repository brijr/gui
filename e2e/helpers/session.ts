import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { _electron as electron } from 'playwright'
import {
  type ElementContext,
  isRegion,
  type Picked,
  type Point,
  type RegionContext,
  type WindowState,
} from '../../src/shared/types'
import { electronExecutable, REPO_ROOT, sleep, waitFor } from './env'
import type { FixtureCopy, FixtureName } from './fixtures'

const TRUSTED_FILE = 'trusted-projects.json'
const RECENT_FILE = 'recent-projects.json'
const PREFS_FILE = 'prefs.json'
/** The chat floating over the preview, as most specs expect, rather than the sidebar. */
const FLOATING_PREFS = { chatSidebar: false, chatCorner: { x: 'right', y: 'bottom' } }

/**
 * GUI_AGENT_STAND_INS for a run: built-in agents to launch as other commands, so a stand-in
 * gets that agent's own settings. Read fresh each time; nothing is replaced until a test
 * writes it.
 */
export const standInsFile = (copy: FixtureCopy) => join(copy.base, 'agent-stand-ins.json')
const PREVIEW_URL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/

export interface LaunchOptions {
  fixture: FixtureName
  /** Pre-trust the project so the native consent dialog cannot block (default true). */
  trusted?: boolean
  /**
   * 'project' opens the fixture at launch (GUI_OPEN). 'recent' seeds recent-projects.json
   * and starts with an empty window, for tests that open the project themselves.
   */
  open?: 'project' | 'recent'
  /** Playwright emulates light on attached pages; this is how a test asks for dark. */
  colorScheme?: 'light' | 'dark'
  /** More environment for the app, e.g. the `SHELL` its terminals start */
  env?: Record<string, string>
  /**
   * Reduce motion, whatever the machine is set to (CI's runner has it on): 'no-preference'
   * (the default) moves things, 'reduce' doesn't. Main gets it through GUI_E2E_REDUCED_MOTION,
   * the window's chrome and chat pages through media emulation. (Pages that open later, such as
   * another tab's chat, keep Playwright's own default, 'no-preference'.)
   */
  reducedMotion?: 'reduce' | 'no-preference'
  /**
   * Preferences saved before launch (prefs.json), e.g. the floating chat's corner. Without
   * any, the chat floats (FLOATING_PREFS): most specs were written for the floating panel.
   * Null saves none, for the app's own defaults (floating chat at the bottom left).
   */
  prefs?: Record<string, unknown> | null
}

export interface ConsentPrompt {
  message: string
  detail: string
}

interface PromptStore {
  guiConsentPrompts?: ConsentPrompt[]
}

interface Layer {
  x: number
  y: number
  url: string
}

interface Layers {
  width: number
  height: number
  out: Layer[]
}

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** Runs in the Electron main process: one PNG per visible view of the first window. */
async function captureLayers(api: ElectronModule): Promise<Layers | null> {
  const { BrowserWindow, WebContentsView } = api
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const [width = 0, height = 0] = win.getContentSize()
  const out = [{ x: 0, y: 0, url: (await win.webContents.capturePage()).toDataURL() }]
  for (const child of win.contentView.children) {
    if (!(child instanceof WebContentsView) || !child.getVisible()) continue
    const bounds = child.getBounds()
    if (bounds.width < 2 || bounds.height < 2) continue
    const image = await child.webContents.capturePage()
    out.push({ x: bounds.x, y: bounds.y, url: image.toDataURL() })
  }
  return { width, height, out }
}

/** What to do in the pick overlay: click at `from`, or drag from it to `to`, holding ⇧ to add. */
interface OverlayGesture {
  from: Point
  to: Point | null
  add: boolean
}

/**
 * Runs in main: real input to the pick overlay that lies over the preview while picking, at
 * points in its coordinates (the preview view's), as the user's pointer would give it.
 */
function overlayGesture({ webContents }: ElectronModule, { from, to, add }: OverlayGesture) {
  const overlay = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/pick.html'))
  if (!overlay) throw new Error('The pick overlay is missing')
  const modifiers: ('shift' | 'leftbuttondown')[] = add ? ['shift'] : []
  const at = ({ x, y }: Point) => ({ x: Math.round(x), y: Math.round(y) })
  overlay.sendInputEvent({ type: 'mouseMove', ...at(from), modifiers })
  overlay.sendInputEvent({
    type: 'mouseDown',
    ...at(from),
    button: 'left',
    clickCount: 1,
    modifiers,
  })
  if (to) {
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      const point = {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      }
      overlay.sendInputEvent({
        type: 'mouseMove',
        ...at(point),
        modifiers: [...modifiers, 'leftbuttondown'],
      })
    }
  }
  overlay.sendInputEvent({
    type: 'mouseUp',
    ...at(to ?? from),
    button: 'left',
    clickCount: 1,
    modifiers,
  })
}

/** Runs in the app chrome page: stacks the layers on a canvas in z-order. */
async function drawLayers({ width, height, out }: Layers): Promise<string> {
  const scale = window.devicePixelRatio
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas is unavailable')
  for (const layer of out) {
    const img = new Image()
    img.src = layer.url
    await img.decode()
    ctx.drawImage(img, layer.x * scale, layer.y * scale, img.width, img.height)
  }
  return canvas.toDataURL('image/png')
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
/** The motion environment is logged once per run, from the first launch. */
let motionLogged = false

/**
 * What the machine says about motion, before the tests' own settings: the system's Reduce
 * motion and refresh rate as main reads them, whether the window has focus, and what each page
 * matches as Playwright attached it. CI's output shows it, to tell its runner apart.
 */
async function logMotionEnvironment(app: ElectronApplication, chrome: Page, chat: Page) {
  if (motionLogged) return
  motionLogged = true
  const main = await app
    .evaluate(({ BrowserWindow, screen, systemPreferences }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return {
        animationSettings: systemPreferences.getAnimationSettings(),
        displayFrequency: win ? screen.getDisplayMatching(win.getBounds()).displayFrequency : null,
        windowFocused: win?.isFocused() ?? null,
        windowVisible: win?.isVisible() ?? null,
      }
    })
    .catch((error: unknown) => ({ error: String(error) }))
  const matches = (page: Page) =>
    page.evaluate((query) => matchMedia(query).matches, REDUCED_MOTION).catch(() => null)
  const pages = {
    chromeReducedMotion: await matches(chrome),
    chatReducedMotion: await matches(chat),
  }
  console.log(`[e2e] motion environment: ${JSON.stringify({ ...main, ...pages })}`)
}

/** A launched Gui window plus the helpers every test needs to drive and inspect it. */
export class GuiSession {
  private closing: Promise<void> | null = null

  constructor(
    readonly app: ElectronApplication,
    /** The app chrome (toolbar, canvas, drawer): `index.html`. */
    readonly chrome: Page,
    /** The floating chat panel: `chat.html`. */
    readonly chat: Page,
    readonly fixture: FixtureCopy,
    private readonly testInfo: TestInfo,
    private readonly output: string[],
  ) {}

  state() {
    return this.chrome.evaluate(() => window.gui.getState())
  }

  chatSnapshot() {
    return this.chat.evaluate(() => window.gui.getChat())
  }

  windowCount(): Promise<number> {
    return this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  }

  /** The previewed app's page (a separate WebContentsView from the chrome). */
  async previewPage(): Promise<Page> {
    const find = () => {
      const pages = this.app.context().pages()
      return pages.find((page) => PREVIEW_URL.test(page.url()))
    }
    return waitFor(find, 'the preview page', { timeout: 30_000 })
  }

  /** Waits for a running dev server and a visible preview; fails fast if the server exits. */
  async waitForPreview(timeout = 150_000): Promise<WindowState> {
    const ready = async () => {
      const state = await this.state()
      const { status } = state.devServer
      const done = status === 'exited' || (status === 'running' && state.preview.visible)
      return done ? state : null
    }
    const state = await waitFor(ready, 'dev server and preview', { timeout })
    if (state.devServer.status === 'exited') {
      const { exitCode, lastLine } = state.devServer
      throw new Error(`Dev server exited (code ${exitCode}): ${lastLine}`)
    }
    return state
  }

  /**
   * Grows the floating chat from its message box to the full panel (its Show conversation)
   * and waits for it to settle there. The panel starts as the box alone until there's a
   * conversation; specs about the panel itself (dragging, resizing, morphing) start here.
   */
  async expandChat(): Promise<void> {
    await this.chat.evaluate(() => window.gui.expandChat())
    await this.chat.waitForFunction(() => {
      const panel = document.querySelector<HTMLElement>('[data-chat-panel]')
      return !!panel && !panel.hasAttribute('data-collapsed') && panel.style.height === ''
    })
  }

  /** Waits for a turn to stop running and returns it with the chat meta at that moment. */
  async waitForTurn(index: number, timeout = 60_000) {
    const finished = async () => {
      const { meta, turns } = await this.chatSnapshot()
      const turn = turns[index]
      return turn && turn.status !== 'running' ? { turn, meta } : null
    }
    return waitFor(finished, `turn ${index + 1} to finish`, { timeout, interval: 500 })
  }

  /** Computed style of an element in the preview. */
  async styleOf(selector: string, property: 'backgroundColor' | 'color'): Promise<string> {
    const preview = await this.previewPage()
    return preview.locator(selector).evaluate((el, prop) => getComputedStyle(el)[prop], property)
  }

  /** The overlay Gui lays over the preview while the user picks. */
  async pickPage(): Promise<Page> {
    const find = () =>
      this.app
        .context()
        .pages()
        .find((page) => page.url().endsWith('/pick.html'))
    return waitFor(find, 'the pick overlay', { timeout: 30_000 })
  }

  /** A click (or with `to`, a drag) in the pick overlay, without waiting for what it does. */
  async overlayGesture(at: Point, options: { to?: Point; add?: boolean } = {}) {
    const gesture: OverlayGesture = { from: at, to: options.to ?? null, add: options.add ?? false }
    await this.app.evaluate(overlayGesture, gesture)
  }

  /** The pointer moves to `at` in the pick overlay, or the wheel turns there by `deltaY`. */
  async overlayPointer(at: Point, deltaY = 0) {
    await this.app.evaluate(
      ({ webContents }, { at, deltaY }) => {
        const overlay = webContents
          .getAllWebContents()
          .find((wc) => wc.getURL().endsWith('/pick.html'))
        const x = Math.round(at.x)
        const y = Math.round(at.y)
        overlay?.sendInputEvent({ type: 'mouseMove', x, y })
        // Chromium's wheel deltas point the way the content moves: negative scrolls down.
        if (deltaY) overlay?.sendInputEvent({ type: 'mouseWheel', x, y, deltaY: -deltaY })
      },
      { at, deltaY },
    )
  }

  /** Turns picking on, unless it is already. */
  async startPicking() {
    if ((await this.state()).preview.selecting) return
    await this.chrome.evaluate(() => window.gui.toggleSelect())
    await waitFor(async () => (await this.state()).preview.selecting, 'picking')
  }

  /**
   * Picks with real input in the overlay, at `at` (the preview view's coordinates): a click,
   * or with `to` a drag for an area; `add` holds ⇧. Resolves with what joined the selection.
   */
  async pickAt(at: Point, options: { to?: Point; add?: boolean } = {}): Promise<Picked> {
    const before = new Set((await this.chatSnapshot()).meta.selection.map((picked) => picked.id))
    await this.startPicking()
    await this.overlayGesture(at, options)
    const settled = async () => {
      const { meta } = await this.chatSnapshot()
      if (meta.selectionError) return { error: meta.selectionError }
      const added = meta.selection.find((picked) => !before.has(picked.id))
      return added ? { added } : null
    }
    const result = await waitFor(settled, 'a pick', { timeout: 20_000, interval: 100 })
    if ('error' in result) throw new Error(`Picking failed: ${result.error}`)
    return result.added
  }

  /** Where an element of the page is drawn, in the preview view: its box at the view's scale. */
  async viewBox(selector: string) {
    const preview = await this.previewPage()
    await preview.waitForSelector(selector, { timeout: 60_000 })
    const box = await preview.locator(selector).boundingBox()
    if (!box) throw new Error(`"${selector}" has no layout box`)
    const { frame, zoom } = (await this.state()).preview
    const scale = frame?.scale ?? zoom
    return {
      x: box.x * scale,
      y: box.y * scale,
      width: box.width * scale,
      height: box.height * scale,
    }
  }

  /** Picks an element as the user does: picking on, then a click on it (⇧-click with `add`). */
  async pickElement(selector: string, options: { add?: boolean } = {}): Promise<ElementContext> {
    const box = await this.viewBox(selector)
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const picked = await this.pickAt(center, options)
    if (isRegion(picked)) throw new Error(`Clicking "${selector}" picked an area`)
    return picked
  }

  /** Drags out an area from `from` to `to` (the preview view's coordinates). */
  async pickArea(from: Point, to: Point, options: { add?: boolean } = {}): Promise<RegionContext> {
    const picked = await this.pickAt(from, { ...options, to })
    if (!isRegion(picked)) throw new Error('The drag picked an element, not an area')
    return picked
  }

  /**
   * Replaces the native "run this dev script?" sheet, which no test can click, with a
   * recorder that answers "Not now". Install it before opening the project.
   */
  declineConsentDialogs(): Promise<void> {
    return this.answerConsentDialogs(false)
  }

  /** Like `declineConsentDialogs`, but agrees; keeps recording into the same list. */
  acceptConsentDialogs(): Promise<void> {
    return this.answerConsentDialogs(true)
  }

  private async answerConsentDialogs(agree: boolean): Promise<void> {
    await this.app.evaluate(
      ({ dialog }, response) => {
        const store = globalThis as unknown as PromptStore
        const prompts = store.guiConsentPrompts ?? []
        store.guiConsentPrompts = prompts
        const answer = (...args: unknown[]) => {
          const options = args.at(-1) as Partial<ConsentPrompt> | undefined
          prompts.push({ message: options?.message ?? '', detail: options?.detail ?? '' })
          return Promise.resolve({ response, checkboxChecked: false })
        }
        dialog.showMessageBox = answer as typeof dialog.showMessageBox
      },
      agree ? 0 : 1,
    )
  }

  consentPrompts(): Promise<ConsentPrompt[]> {
    return this.app.evaluate(() => {
      const store = globalThis as unknown as PromptStore
      return store.guiConsentPrompts ?? []
    })
  }

  /**
   * Composite screenshot of the whole window, attached to the test and written under
   * test-results/. Only on request (GUI_E2E_SHOTS=1) or when `force`d, as on failure.
   */
  async shot(name: string, force = false): Promise<void> {
    if (!force && process.env.GUI_E2E_SHOTS !== '1') return
    const layers = await this.app.evaluate(captureLayers)
    if (!layers) return
    const dataUrl = await this.chrome.evaluate(drawLayers, layers)
    const file = this.testInfo.outputPath(`${name}.png`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'))
    await this.testInfo.attach(name, { path: file, contentType: 'image/png' })
  }

  /** Everything worth reading after a failure: screenshot, dev-server log, app output. */
  async captureDiagnostics(): Promise<void> {
    await this.shot('failure', true).catch(() => undefined)
    const logs = await this.chrome
      .evaluate(async () => (await window.gui.getLogs()).data)
      .catch(() => '')
    const state = await this.state().catch(() => null)
    await this.attach('dev-server.log', logs)
    await this.attach('app-output.log', this.output.join(''))
    await this.attach('window-state.json', JSON.stringify(state, null, 2))
  }

  /** Quits the app; again (as the fixture does after a test that quit it) does nothing. */
  close(): Promise<void> {
    this.closing ??= closeApp(this.app)
    return this.closing
  }

  private attach(name: string, body: string) {
    return this.testInfo.attach(name, { body: body || '(empty)', contentType: 'text/plain' })
  }
}

/** Quits the way a user would; kills the process if it hangs (for example on an open sheet). */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process()
  await Promise.race([app.close().catch(() => undefined), sleep(20_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await sleep(500)
  }
}

function launchEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Either would stop Electron from behaving like the app a user launches.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  // Windows show without taking the keyboard from the app the user is in. Most specs aren't
  // about the Gui account, so it isn't asked for unless a spec sets GUI_ACCOUNT_REQUIRED=1.
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: '1',
    GUI_E2E_BACKGROUND: '1',
    GUI_ACCOUNT_REQUIRED: '0',
    ...extra,
  }
}

async function findPage(app: ElectronApplication, suffix: string): Promise<Page> {
  const find = () => {
    const pages = app.context().pages()
    return pages.find((page) => page.url().endsWith(suffix))
  }
  return waitFor(find, `the ${suffix} window`, { timeout: 45_000 })
}

/**
 * Launches the built app (`out/`, from `electron-vite build`) with an isolated profile.
 * GUI_OPEN and GUI_AGENT_STAND_INS are always set explicitly so a value in the caller's
 * shell can't leak in.
 */
export async function launchGui(
  copy: FixtureCopy,
  options: LaunchOptions,
  testInfo: TestInfo,
): Promise<GuiSession> {
  if (options.trusted !== false) {
    writeFileSync(join(copy.userData, TRUSTED_FILE), JSON.stringify([copy.root]))
  }
  const prefs = options.prefs === undefined ? FLOATING_PREFS : options.prefs
  if (prefs) {
    writeFileSync(join(copy.userData, PREFS_FILE), JSON.stringify({ ...FLOATING_PREFS, ...prefs }))
  }
  if (options.open === 'recent') {
    const recent = [{ root: copy.root, name: copy.spec.name, openedAt: 1 }]
    writeFileSync(join(copy.userData, RECENT_FILE), JSON.stringify(recent))
  }

  const reducedMotion = options.reducedMotion ?? 'no-preference'
  const app = await electron.launch({
    executablePath: electronExecutable(),
    args: [REPO_ROOT, `--user-data-dir=${copy.userData}`],
    env: launchEnv({
      ...options.env,
      GUI_OPEN: options.open === 'recent' ? '' : copy.root,
      GUI_AGENT_STAND_INS: standInsFile(copy),
      GUI_E2E_REDUCED_MOTION: reducedMotion === 'reduce' ? '1' : '0',
    }),
    colorScheme: options.colorScheme ?? 'light',
    timeout: 60_000,
  })
  const output: string[] = []
  const collect = (chunk: Buffer) => {
    output.push(chunk.toString())
  }
  app.process().stdout?.on('data', collect)
  app.process().stderr?.on('data', collect)

  try {
    const chrome = await findPage(app, '/index.html')
    const chat = await findPage(app, '/chat.html')
    // The preload exposes window.gui before page scripts run, but be explicit.
    await chrome.waitForFunction(() => 'gui' in window)
    await chat.waitForFunction(() => 'gui' in window)
    await logMotionEnvironment(app, chrome, chat)
    await chrome.emulateMedia({ reducedMotion })
    await chat.emulateMedia({ reducedMotion })
    return new GuiSession(app, chrome, chat, copy, testInfo, output)
  } catch (error) {
    await closeApp(app)
    throw error
  }
}
