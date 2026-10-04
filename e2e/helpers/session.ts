import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { _electron as electron } from 'playwright'
import type { ChatMeta, ElementContext, WindowState } from '../../src/shared/types'
import { electronExecutable, REPO_ROOT, sleep, waitFor } from './env'
import type { FixtureCopy, FixtureName } from './fixtures'

const TRUSTED_FILE = 'trusted-projects.json'
const RECENT_FILE = 'recent-projects.json'

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

/** A launched Gui window plus the helpers every test needs to drive and inspect it. */
export class GuiSession {
  constructor(
    readonly app: ElectronApplication,
    /** The app chrome (toolbar, canvas, logs drawer): `index.html`. */
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

  /** Picks an element through the real inspect-mode flow: toggle, hover, click. */
  async pickElement(selector: string): Promise<ElementContext> {
    const preview = await this.previewPage()
    await preview.waitForSelector(selector, { timeout: 60_000 })
    await this.chrome.evaluate(() => window.gui.toggleSelect())
    await waitFor(async () => (await this.state()).preview.selecting, 'selection mode')

    // `selecting` flips before the inspector has finished arming, so an early click can
    // land on the page instead. That only presses the button; click again once armed.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sleep(500)
      const box = await preview.locator(selector).boundingBox()
      if (!box) throw new Error(`"${selector}" has no layout box to click`)
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await preview.mouse.move(x, y)
      await sleep(300)
      await preview.mouse.click(x, y)
      const meta = await this.pollSelection(8_000)
      if (meta?.selectionError) throw new Error(`Picking failed: ${meta.selectionError}`)
      if (meta?.selection) return meta.selection
    }
    throw new Error(`Clicking "${selector}" in selection mode never produced a selection`)
  }

  private async pollSelection(timeout: number): Promise<ChatMeta | null> {
    const check = async () => {
      const { meta } = await this.chatSnapshot()
      const settled = meta.selection !== null || meta.selectionError !== null
      return settled ? meta : null
    }
    try {
      return await waitFor(check, 'an element selection', { timeout, interval: 200 })
    } catch {
      return null
    }
  }

  /**
   * Replaces the native "run this dev script?" sheet, which no test can click, with a
   * recorder that answers "Not now". Install it before opening the project.
   */
  async declineConsentDialogs(): Promise<void> {
    await this.app.evaluate(({ dialog }) => {
      const prompts: ConsentPrompt[] = []
      const store: PromptStore = { guiConsentPrompts: prompts }
      Object.assign(globalThis, store)
      const decline = (...args: unknown[]) => {
        const options = args.at(-1) as Partial<ConsentPrompt> | undefined
        prompts.push({ message: options?.message ?? '', detail: options?.detail ?? '' })
        return Promise.resolve({ response: 1, checkboxChecked: false })
      }
      dialog.showMessageBox = decline as typeof dialog.showMessageBox
    })
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
    const logs = await this.chrome.evaluate(() => window.gui.getLogs()).catch(() => '')
    const state = await this.state().catch(() => null)
    await this.attach('dev-server.log', logs)
    await this.attach('app-output.log', this.output.join(''))
    await this.attach('window-state.json', JSON.stringify(state, null, 2))
  }

  close(): Promise<void> {
    return closeApp(this.app)
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
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...extra }
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
  if (options.open === 'recent') {
    const recent = [{ root: copy.root, name: copy.spec.name, openedAt: 1 }]
    writeFileSync(join(copy.userData, RECENT_FILE), JSON.stringify(recent))
  }

  const app = await electron.launch({
    executablePath: electronExecutable(),
    args: [REPO_ROOT, `--user-data-dir=${copy.userData}`],
    env: launchEnv({
      GUI_OPEN: options.open === 'recent' ? '' : copy.root,
      GUI_AGENT_STAND_INS: standInsFile(copy),
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
    return new GuiSession(app, chrome, chat, copy, testInfo, output)
  } catch (error) {
    await closeApp(app)
    throw error
  }
}
