import { join } from 'node:path'
import { app, shell, type WebContents } from 'electron'
import { sendCrashReport } from './crash-reports'

export type RendererPage = 'index' | 'chat' | 'settings' | 'pick' | 'guides'

/** Preload for Gui's own UI; the preview never gets it. */
export const PRELOAD = join(import.meta.dirname, '../preload/index.cjs')
/**
 * The preview's own preload: it edits page text in place, and tells main how far the page is
 * scrolled and about ⇧R for the guides (src/preload/preview.ts).
 */
export const PREVIEW_PRELOAD = join(import.meta.dirname, '../preload/preview.cjs')

function rendererUrl(page: RendererPage) {
  // Never honor the dev-server override in packaged builds: it would load remote
  // content into renderers that have the privileged preload.
  if (app.isPackaged) return null
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? `${dev}/${page}.html` : null
}

export function loadRenderer(wc: WebContents, page: RendererPage) {
  const url = rendererUrl(page)
  if (url) return wc.loadURL(url)
  return wc.loadFile(join(import.meta.dirname, `../renderer/${page}.html`))
}

/** Gui's own pages, which have the privileged preload; previews never are. */
const appContents = new WeakSet<WebContents>()

export function isAppContents(wc: WebContents) {
  return appContents.has(wc)
}

/** App UI never navigates or opens windows; web links go to the user's browser. */
export function guardAppContents(wc: WebContents) {
  appContents.add(wc)
  const openExternal = (url: string) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(() => undefined)
  }
  wc.on('will-navigate', (event, url) => {
    if (url === wc.getURL()) return
    event.preventDefault()
    openExternal(url)
  })
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  reloadAfterCrash(wc)
}

/** A crashed app page reloaded more often than this in a minute is left as it is. */
const MAX_CRASH_RELOADS = 3

/**
 * Gui's own pages hold no state main doesn't have, so one whose renderer crashed loads again
 * and is sent it, instead of staying blank. A page that keeps crashing stops being reloaded.
 */
function reloadAfterCrash(wc: WebContents) {
  let reloads: number[] = []
  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || wc.isDestroyed()) return
    const now = Date.now()
    reloads = reloads.filter((at) => now - at < 60_000)
    console.error(`[gui] ${wc.getURL()} renderer gone (${details.reason})`)
    // Which page, not its full address: a file URL names the user's folders.
    const page = wc.getURL().split('/').pop()?.split(/[?#]/)[0] ?? 'unknown'
    sendCrashReport({
      kind: 'renderer',
      message: `${page} renderer gone (${details.reason}, exit code ${details.exitCode})`,
    })
    if (reloads.length >= MAX_CRASH_RELOADS) return
    reloads.push(now)
    wc.reload()
  })
}
