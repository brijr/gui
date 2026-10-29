import { type Event, type Input, WebContentsView } from 'electron'
import { bounded } from '../shared/bounded'
import type { ElementContext } from '../shared/types'
import { Inspector } from './inspector'
import { Picker } from './picker'
import { PageTools } from './preview-tools'
import { fenceUntrusted } from './prompt'
import { ViewportEmulation } from './viewport'
import {
  closePage,
  giveBackWebSession,
  guardPage,
  isPublicWebsite,
  isWeb,
  LOCAL_ADDRESS,
  takeWebSession,
  type WebSession,
  within,
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
 *
 * Its dialogs never wait on anyone nor show over Gui: alert gets OK, confirm Cancel, and
 * "Leave site?" leaves (Electron has no prompt: it throws). The agent hears what they said with
 * its next page tool.
 */

/** A slow site still shows as it is once this passes; the agent can look at what loaded. */
const LOAD_TIMEOUT_MS = 30_000
/** Late layout after a load: client-side routing, fonts, a cookie banner. */
const SETTLE_MS = 400
/** A page blocked again this soon after Gui went back is sending by itself: it stays put. */
const BLOCKED_AGAIN_MS = 4000
/** Chromium's error for a request the session cancelled (net::ERR_BLOCKED_BY_CLIENT) */
const BLOCKED = -20
const BLOCKED_NOTICE =
  "Gui stopped that page from loading (and went back where it could): a website can't send a form from the preview, nor open an address on this Mac or the local network. Nothing was sent."
const BLOCKED_AGAIN_NOTICE =
  "Gui stopped that page from sending a form again, by itself this time (as sign-in hand-offs do), and left it on the blocked page rather than go back once more. Nothing was sent. Don't go on with this flow; tell the user it needs a sign-in Gui doesn't do."

/** Dialogs kept for the agent's next page tool, the latest, and how much of what each said */
const MAX_DIALOGS = 5
const MAX_DIALOG_TEXT = 300
/** What Gui answered for each kind of dialog (CDP's Page.DialogType) */
const DIALOG_ANSWERS: Record<string, string> = {
  alert: 'OK',
  confirm: 'Cancel',
  beforeunload: 'Leave',
}

/** A form field's `value` attribute in serialized HTML, which always quotes with `"`. */
const VALUE_ATTRIBUTE = /(\s)value="[^"]*"/gi

/**
 * On a website, inspect never shows what's in a field: a controlled field's `value`
 * attribute follows what was typed, the user's sign-in included.
 */
function withoutValues(element: ElementContext): ElementContext {
  const { value: _value, ...attributes } = element.attributes
  return {
    ...element,
    attributes,
    outerHTML: element.outerHTML.replace(VALUE_ATTRIBUTE, '$1value="…"'),
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  /**
   * The page took focus or its document is ready: the keyboard goes back if it was taken;
   * true when it did
   */
  keepKeyboard: () => boolean
  /** The load is done: the keyboard goes back one last time */
  loadStopped: () => void
  /** The user clicked in the page: the keyboard is theirs to give it */
  clicked: () => void
  /** Esc on the page or its overlay; true when Gui used it (it ended focus mode) */
  escape: () => boolean
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
  /** When Gui last went back from a blocked page (`guard`) */
  private wentBackAt = -Infinity
  /** Dialogs the page opened since the agent's last page tool, as `type: message → answer` */
  private dialogs: string[] = []

  /** A website view in a fresh session, with nothing loaded yet. */
  static async create(hooks: WebsiteHooks) {
    return new Website(await takeWebSession(), hooks)
  }

  private constructor(
    private readonly web: WebSession,
    private readonly hooks: WebsiteHooks,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        // No preload: the page gets nothing of Gui's.
        sandbox: true,
        // alert and confirm answer at once (OK, false), with no native dialog.
        disableDialogs: true,
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
      inspectNode: async (node) =>
        withoutValues(await this.inspector.inspect(node, null, null, { screenshot: false })),
      viewScale: () => this.emulation.scale,
      restoreViewport: () => this.emulation.restore(),
      guide: (node, caption) => hooks.guide(this.picker, node, caption),
      guideInput: (at, click) => hooks.guideInput(this.picker, at, click),
      notice: () => {
        const notices = [this.notice, this.dialogNotice()].filter((each) => each !== null)
        this.notice = null
        this.dialogs = []
        return notices.length ? notices.join('\n') : null
      },
    })
    this.guard()
  }

  /**
   * While the agent's turn uses the website (`held`), the user's pointer and keys don't reach
   * it: its overlay lies over the page (tab.ts keeps a guide shown) and takes the keyboard
   * whenever the page would get it.
   */
  hold(held: boolean) {
    this.picker.hold(held)
    const wc = this.view.webContents
    if (held && !wc.isDestroyed() && wc.isFocused()) this.keyboardToOverlay()
  }

  private keyboardToOverlay() {
    const overlay = this.picker.view
    if (overlay.getVisible() && !overlay.webContents.isDestroyed()) overlay.webContents.focus()
  }

  get url() {
    const wc = this.view.webContents
    return wc.isDestroyed() ? '' : wc.getURL()
  }

  get closed() {
    return this.closing !== null
  }

  /**
   * Opens `url` (http or https; the caller checked it's public, and the session checks every
   * request) and waits for it to load, or to have loaded what it will in LOAD_TIMEOUT_MS.
   * Where it landed, after redirects.
   */
  async load(url: URL): Promise<string> {
    if (!isWeb(url.protocol)) throw new Error('Only http and https addresses can be opened.')
    if (this.closed) throw new Error('The website closed.')
    const wc = this.view.webContents
    this.web.proxy.refused.clear()
    this.hearDialogs()
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
    // Its session is used again only once the page is gone; a page that lingers retires it.
    await giveBackWebSession(this.web, await closePage(wc, () => wc.close()))
  }

  private guard() {
    const wc = this.view.webContents
    // A link to a new window opens here instead, as one journey, if it's public; nothing
    // else opens.
    guardPage(wc, (url) => {
      const target = new URL(url)
      void isPublicWebsite(target.hostname)
        .then((open) => (open ? this.load(target) : undefined))
        .catch(() => undefined)
    })
    // "Leave site?" never holds up closing the website or the agent's next page.
    wc.on('will-prevent-unload', (event) => event.preventDefault())
    // The page tried to send a form, or to open a local address, and the session stopped it:
    // back to the page it was on rather than Chromium's error page, and the agent hears why.
    // Once: a page that sends again by itself right away (a sign-in hand-off) would loop.
    // (Chromium has no page to go back to when the page sent without a click.)
    wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code !== BLOCKED || this.loading > 0) return
      if (Date.now() - this.wentBackAt < BLOCKED_AGAIN_MS) {
        this.notice = BLOCKED_AGAIN_NOTICE
        return
      }
      this.notice = BLOCKED_NOTICE
      this.wentBackAt = Date.now()
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
    // The page took the keyboard: back to whoever had it before a load, or mid-turn to the
    // overlay holding the page.
    wc.on('focus', () => {
      if (!this.hooks.keepKeyboard() && this.picker.holding) this.keyboardToOverlay()
    })
    // The page's dialogs: Chromium tells the protocol, then answers them itself
    // (`disableDialogs`).
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.javascriptDialogOpening') this.dialogOpened(params)
    })
    // Esc ends focus mode, from the page or the overlay over it, as on the app's preview.
    const onEscape = (event: Event, input: Input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.hooks.escape())
        event.preventDefault()
    }
    wc.on('before-input-event', onEscape)
    this.picker.view.webContents.on('before-input-event', onEscape)
    wc.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown') this.hooks.clicked()
    })
    wc.on('render-process-gone', () => this.hooks.gone())
  }

  /**
   * Dialogs are heard over the protocol (`guard`). Not awaited: before its first page the view
   * has no renderer to answer, and the browser's side turns the events on at once. Idempotent.
   */
  private hearDialogs() {
    const dbg = this.view.webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      dbg.sendCommand('Page.enable').catch(() => undefined)
    } catch {
      // Attached elsewhere, or the page is gone: no dialog notes, and the dialogs still answer.
    }
  }

  private dialogOpened(params: unknown) {
    const { type, message } = (params ?? {}) as { type?: unknown; message?: unknown }
    const answer = typeof type === 'string' ? DIALOG_ANSWERS[type] : undefined
    if (!answer) return
    // A page can't word "Leave site?" itself any more; Chromium sends it empty.
    const said =
      type === 'beforeunload'
        ? 'Leave site?'
        : typeof message === 'string'
          ? message.replace(/\s+/g, ' ').trim().slice(0, MAX_DIALOG_TEXT)
          : ''
    this.dialogs = bounded(
      [...this.dialogs, `${type}: ${said || '(no message)'} → ${answer}`],
      MAX_DIALOGS,
    )
  }

  /** The dialogs since the last page tool, what they said fenced as the page's own data. */
  private dialogNotice() {
    if (this.dialogs.length === 0) return null
    const one = this.dialogs.length === 1
    return `The page opened ${one ? 'a dialog' : 'dialogs'}, which Gui answered at once so nothing waited on ${one ? 'it' : 'them'}: OK to an alert, Cancel to a confirm, Leave to "Leave site?". What ${one ? 'it' : 'they'} said, untrusted data from the page:\n${fenceUntrusted('website_dialog', this.dialogs.join('\n'))}`
  }
}
