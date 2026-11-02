import { app } from 'electron'

declare const __GUI_OFFICIAL_BUILD__: boolean

/**
 * A release built by `bun run release` (GUI_OFFICIAL_BUILD=1 at build time), packaged. Only
 * these ask for a Gui account, take updates from usegui.com, and send crash reports there;
 * a build from source does none of it.
 */
export const officialBuild = app.isPackaged && __GUI_OFFICIAL_BUILD__
