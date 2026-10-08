import { join } from 'node:path'
import { app, shell, type WebContents } from 'electron'

export type RendererPage = 'index' | 'chat' | 'settings' | 'pick'

/** Preload for Gui's own UI; the preview never gets it. */
export const PRELOAD = join(import.meta.dirname, '../preload/index.cjs')

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

/** App UI never navigates or opens windows; web links go to the user's browser. */
export function guardAppContents(wc: WebContents) {
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
    if (reloads.length >= MAX_CRASH_RELOADS) return
    reloads.push(now)
    wc.reload()
  })
}
