import { WebContentsView } from 'electron'
import { Inspector } from './inspector'
import { Picker } from './picker'
import { PageTools } from './preview-tools'
import { ViewportEmulation } from './viewport'
import {
  isPublicWebsite,
  LOCAL_ADDRESS,
  type WebSession,
  webSession,
  wipeWebSession,
} from './web-session'

/**
 * A website the agent opened in the preview, to use it like a user and report how it works
 * ("how does linear.app do onboarding?"). It shows in the preview's place, over the user's app,
 * with the agent's pointer and captions drawn by an overlay of its own (picker.ts), and the
 * same page tools as the app (`tools`).
 *
 * It never shares the user's sign-ins: it runs in an in-memory session apart from the
 * preview's and from anything the user signed into in Gui, locked down as canvas captures are
 * (web-session.ts: public addresses only, no permissions, downloads or form posts). That
 * session is wiped before it's used and again when the website closes. New windows open in the
 * same view; other schemes (file:, chrome:, app protocols) are refused.
 */

/** A slow site still shows as it is once this passes; the agent can look at what loaded. */
const LOAD_TIMEOUT_MS = 30_000
/** Late layout after a load: client-side routing, fonts, a cookie banner. */
const SETTLE_MS = 400
const CLOSE_TIMEOUT_MS = 3000
/** Chromium's error for a request the session cancelled (net::ERR_BLOCKED_BY_CLIENT) */
const BLOCKED = -20
const BLOCKED_NOTICE =
  "Gui stopped that page from loading and went back: a website can't send a form from the preview, nor open an address on this Mac or the local network. Nothing was sent."

/** Wiped sessions not in use. Electron never frees a session, so a closed website's is reused. */
const idleSessions: string[] = []
let sessionsMade = 0

async function takeSession(): Promise<{ partition: string; web: WebSession }> {
  const partition = idleSessions.pop() ?? `gui-website-${++sessionsMade}`
  const web = await webSession(partition)
  // Already wiped when it was given back; again, in case anything lingered.
  if (!(await wipeWebSession(web))) throw new Error("Couldn't start a fresh browser session.")
  return { partition, web }
}

/** Only a session wiped clean goes back to be used again. */
async function giveBack(partition: string, web: WebSession) {
  if (await wipeWebSession(web)) idleSessions.push(partition)
}

function within<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isWeb = (url: string) => /^https?:/i.test(url)

export interface WebsiteHooks {
  /** A walkthrough step on `picker` (the website's overlay); whether the user can see it */
  guide: (picker: Picker, node: number | null, caption: string | null) => boolean
  /** The agent's pointer goes to an input's target on `picker` first */
  guideInput: (picker: Picker, at: { x: number; y: number }, click: boolean) => Promise<void>
  /** The page's address changed */
  navigated: (url: string) => void
  /** Its page crashed */
  gone: () => void
  /** A new document is loading: whoever has the keyboard keeps it (tab.ts keepKeyboard) */
  loadStarted: () => void
  /** The page took focus or its document is ready: the keyboard goes back if it was taken */
  keepKeyboard: () => void
  /** The load is done: the keyboard goes back one last time */
  loadStopped: () => void
  /** The user clicked in the page: the keyboard is theirs to give it */
  clicked: () => void
}

export class Website {
  readonly view: WebContentsView
  readonly inspector: Inspector
  readonly emulation: ViewportEmulation
  /** The agent's pointer and captions over the website */
  readonly picker: Picker
  readonly tools: PageTools
  private closing: Promise<void> | null = null
  /** A `load` is under way, and reports its own failures */
  private loading = 0
  /** What happened that the agent's next page tool should hear (`takeNotice`) */
  private notice: string | null = null

  /** A website view in a fresh session, with nothing loaded yet. */
  static async create(hooks: WebsiteHooks) {
    const { partition, web } = await takeSession()
    return new Website(partition, web, hooks)
  }

  private constructor(
    private readonly partition: string,
    private readonly web: WebSession,
    private readonly hooks: WebsiteHooks,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        // No preload: the page gets nothing of Gui's.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: web.ses,
      },
    })
    this.view.setBackgroundColor('#ffffff')
    this.view.setVisible(false)
    const wc = this.view.webContents
    this.inspector = new Inspector(wc, () => this.emulation.scale)
    this.emulation = new ViewportEmulation(this.inspector)
    this.picker = new Picker(wc, this.inspector, () => this.emulation.scale)
    this.tools = new PageTools({
      kind: 'website',
      wc,
      inspector: this.inspector,
      // Styles and markup only: a website's source isn't the user's to look up.
      inspectNode: (node) => this.inspector.inspect(node, null, null, { screenshot: false }),
      viewScale: () => this.emulation.scale,
      restoreViewport: () => this.emulation.restore(),
      guide: (node, caption) => hooks.guide(this.picker, node, caption),
      guideInput: (at, click) => hooks.guideInput(this.picker, at, click),
      notice: () => {
        const notice = this.notice
        this.notice = null
        return notice
      },
    })
    this.guard()
  }

  get url() {
    const wc = this.view.webContents
    return wc.isDestroyed() ? '' : wc.getURL()
  }

  get closed() {
    return this.closing !== null
  }

  /**
   * Opens `url` (http or https, and public) and waits for it to load, or to have loaded what
   * it will in LOAD_TIMEOUT_MS. Where it landed, after redirects.
   */
  async load(url: URL): Promise<string> {
    if (!isWeb(url.protocol)) throw new Error('Only http and https addresses can be opened.')
    if (!(await isPublicWebsite(url.hostname))) throw new Error(LOCAL_ADDRESS)
    if (this.closed) throw new Error('The website closed.')
    const wc = this.view.webContents
    this.web.proxy.refused.clear()
    let failed: string | null = null
    const onFail = (
      _event: unknown,
      code: number,
      description: string,
      _url: string,
      mainFrame: boolean,
    ) => {
      // -3 is an aborted load, which a redirect or a client-side navigation also causes.
      // -20 is a request blocked by the session: a local address or a form post.
      if (!mainFrame || code === -3) return
      failed = code === -20 || this.web.proxy.refused.size > 0 ? LOCAL_ADDRESS : description
    }
    wc.on('did-fail-load', onFail)
    this.loading++
    try {
      await within(wc.loadURL(url.toString()), LOAD_TIMEOUT_MS)
    } finally {
      this.loading--
      if (!wc.isDestroyed()) wc.off('did-fail-load', onFail)
    }
    if (this.closed) throw new Error('The website closed.')
    if (failed) throw new Error(`Couldn't open ${url}: ${failed}`)
    await sleep(SETTLE_MS)
    return this.url
  }

  /** Closes the page and wipes its session (cookies, storage, cache) for the next website. */
  close(): Promise<void> {
    this.closing ??= this.shutDown()
    return this.closing
  }

  private async shutDown() {
    this.picker.dispose()
    this.emulation.dispose()
    this.inspector.dispose()
    const wc = this.view.webContents
    if (!wc.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => wc.once('destroyed', () => resolve()))
      wc.close()
      await within(destroyed, CLOSE_TIMEOUT_MS)
    }
    await giveBack(this.partition, this.web)
  }

  private guard() {
    const wc = this.view.webContents
    wc.setAudioMuted(true)
    // WebRTC's UDP would go around the proxy: it's left only what the proxy carries (nothing).
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // A link to a new window opens here instead, as one journey; nothing else opens.
    wc.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) void this.load(new URL(url)).catch(() => undefined)
      return { action: 'deny' }
    })
    // Navigation in any frame, and redirects, stay on the web: no app protocols or local files.
    wc.on('will-frame-navigate', (event) => {
      if (!isWeb(event.url)) event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
      if (!isWeb(url)) event.preventDefault()
    })
    // "Leave site?" never holds up closing the website or the agent's next page.
    wc.on('will-prevent-unload', (event) => event.preventDefault())
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault()
      callback('')
    })
    // The page tried to send a form, or to open a local address, and the session stopped it:
    // back to the page it was on rather than Chromium's error page, and the agent hears why.
    wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code !== BLOCKED || this.loading > 0) return
      this.notice = BLOCKED_NOTICE
      setTimeout(() => {
        if (!wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      }, 0)
    })
    wc.on('did-navigate', (_event, url) => this.hooks.navigated(url))
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.hooks.navigated(url)
    })
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.hooks.loadStarted()
    })
    wc.on('did-stop-loading', () => this.hooks.loadStopped())
    wc.on('dom-ready', () => this.hooks.keepKeyboard())
    wc.on('focus', () => this.hooks.keepKeyboard())
    wc.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown') this.hooks.clicked()
    })
    wc.on('render-process-gone', () => this.hooks.gone())
  }
}
