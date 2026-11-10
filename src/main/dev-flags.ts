import { app } from 'electron'
import { setFrameLimitForDevelopment } from '../shared/board'

/**
 * Switches for trying Gui at sizes users can't reach yet. Unpackaged builds only: a packaged
 * Gui ignores them.
 *
 *   GUI_DEV_MAX_FRAMES=1000  a canvas may hold that many frames (users get MAX_FRAMES)
 */
export function applyDevFlags() {
  if (app.isPackaged) return
  const frames = Number(process.env.GUI_DEV_MAX_FRAMES)
  if (frames) setFrameLimitForDevelopment(frames)
}
