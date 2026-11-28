import { EventEmitter } from 'node:events'
import { app, dialog, powerMonitor, autoUpdater as squirrel } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { IS_MAC } from '../shared/platform'
import { track } from './analytics'
import { updateFailure } from './analytics-queue'
import { officialBuild } from './official-build'
import { updatePrompts } from './update-prompts'
import { updateSchedule } from './update-schedule'

/** How long a restart the user chose may take before Gui says it didn't happen. */
const RESTART_WAIT = 60 * 1000

let updater: Promise<AppUpdater> | null = null

/**
 * Whether this copy can replace itself with a new version: the Mac app (Squirrel.Mac installs
 * it) and the Linux AppImage (electron-updater swaps the file; the AppImage runtime sets
 * APPIMAGE). A .deb is updated by installing the new one, so it never looks for one.
 */
const updatesItself = IS_MAC || Boolean(process.env.APPIMAGE)

/** The downloaded version a restart installs, once there is one; 'change' when it's offered. */
let ready: string | null = null
export const updateOffer = new EventEmitter<{ change: [version: string] }>()

/** The version Restart to Update installs, or null with none downloaded. */
export const readyUpdate = () => ready

/** When Gui checks, and the failures usage data counts (see update-schedule.ts) */
const schedule = updateSchedule({
  check,
  handsOff: IS_MAC,
  now: Date.now,
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms)
    // Must not hold a quitting Gui open.
    timer.unref()
    return () => clearTimeout(timer)
  },
  // Why, as a name from a fixed list; never the error itself.
  countFailed: (stage, error) => track('update_failed', { stage, reason: updateFailure(error) }),
})

const prompts = updatePrompts({
  updater: {
    check: () => schedule.checkByHand(),
    downloading: () => schedule.downloading(),
    quitAndInstall: async () => (await loadUpdater()).quitAndInstall(),
  },
  dialog,
  version: () => app.getVersion(),
  inApplications: () => !IS_MAC || app.isInApplicationsFolder(),
  // Only ever says the restart didn't happen; unref'd so it can't hold a quitting Gui open.
  afterRestartWait: (run) => void setTimeout(run, RESTART_WAIT).unref(),
  offer: (version) => {
    ready = version
    updateOffer.emit('change', version)
  },
})

/** Restart to Update (the app menu, the window's toolbar): restarts into the downloaded version. */
export function restartToUpdate() {
  void prompts.restartToUpdate()
}

/**
 * electron-updater, loaded the first time it's needed rather than before the first window:
 * it takes tens of milliseconds to load.
 */
function loadUpdater() {
  updater ??= import('electron-updater').then((module) => {
    // CommonJS: its named exports are on the default export.
    const { autoUpdater } = module.default
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // So usegui.com can count update checks by version (www/worker.js); nothing else about the user.
    autoUpdater.requestHeaders = { 'User-Agent': `Gui/${app.getVersion()}` }
    // Also on every later check while the downloaded file is still good (AppUpdater.js:604).
    autoUpdater.on('update-downloaded', (info) => {
      schedule.downloaded(info.version)
      prompts.downloaded(info.version)
    })
    // A failed check or download; the schedule counts the downloads that failed.
    autoUpdater.on('error', failed)
    // On a Mac, electron-updater hands each download to Squirrel.Mac, Electron's own updater,
    // which installs it. Only Squirrel.Mac's events say whether a restart can happen. On Linux
    // they never fire: electron-updater replaces the AppImage itself when Gui restarts.
    squirrel.on('update-downloaded', () => {
      schedule.installReady()
      prompts.installReady()
    })
    squirrel.on('error', (error) => {
      schedule.installFailed(error)
      prompts.installFailed(error)
    })
    return autoUpdater
  })
  return updater
}

function failed(error: Error) {
  console.error('Update failed:', error)
  prompts.failed(error)
}

/**
 * Keeps an installed Gui up to date from the feed in electron-builder.yml (`publish`). New
 * versions download in the background; once one is ready Gui offers Restart to Update, quietly
 * in the app menu and the toolbar, and otherwise installs it when the user next quits. Squirrel.Mac only applies an update signed
 * by the same Developer ID, so only official releases check; builds from source never do, and
 * neither does a copy that can't replace itself (`updatesItself`).
 */
export function startUpdates() {
  if (!officialBuild || !updatesItself) return
  schedule.start()
  // Timers don't count sleep, and a laptop often wakes onto another network. Electron's main
  // process has no event for coming back online; a check that fails offline tries again soon.
  powerMonitor.on('resume', () => schedule.resumed())
  app.on('before-quit', () => schedule.stop())
}

/** Gui → Check for Updates…: says what it found, unlike the quiet background checks. */
export async function checkForUpdatesByHand() {
  if (!officialBuild) {
    await dialog.showMessageBox({
      message: 'Updates are off in builds from source',
      detail: 'Pull the latest main and rebuild instead.',
    })
    return
  }
  if (!updatesItself) {
    await dialog.showMessageBox({
      message: 'Gui installed from a .deb doesn’t update itself',
      detail: 'Download the newest version from https://usegui.com/download and install it.',
    })
    return
  }
  await prompts.checkByHand()
}

/** One check; rejects when it fails, which `failed` has been told. */
async function check() {
  let autoUpdater: AppUpdater
  try {
    autoUpdater = await loadUpdater()
  } catch (error) {
    updater = null
    const reason = error instanceof Error ? error : new Error(String(error))
    failed(reason)
    throw reason
  }
  // Fails through the 'error' event too (AppUpdater.js:271). The download it starts
  // (`autoDownload`) is the schedule's to wait for.
  return autoUpdater.checkForUpdates()
}
