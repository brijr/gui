import { app } from 'electron'

/**
 * `GUI_BOARD_WEBGL=1`: the canvas board's pixels are drawn with WebGL
 * (src/renderer/src/board/gl) rather than as DOM tiles. A development switch while that
 * renderer reaches parity: an unpackaged build only, so a packaged Gui ignores it.
 */
export const devBoardWebgl = !app.isPackaged && process.env.GUI_BOARD_WEBGL === '1'
