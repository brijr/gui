import { EventEmitter } from 'node:events'
import { app, dialog, autoUpdater as squirrel } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { IS_MAC, IS_WINDOWS } from '../shared/platform'
import { track } from './analytics'
import { officialBuild } from './official-build'
import { updatePrompts } from './update-prompts'

/** How often a running Gui looks for a new version, after the check at launch. */
const CHECK_EVERY = 4 * 60 * 60 * 1000

/** How long a restart the user chose may take before Gui says it didn't happen. */
const RESTART_WAIT = 60 * 1000

let updater: Promise<AppUpdater> | null = null

/**
 * Whether this copy can replace itself with a new version: the Mac app (Squirrel.Mac installs
 * it) and the Linux AppImage (electron-updater swaps the file; the AppImage runtime sets
 * APPIMAGE). A .deb is updated by installing the new one, so it never looks for one; nor,
 * for now, does Gui for Windows.
 */
const updatesItself = IS_MAC || Boolean(process.env.APPIMAGE)

/** The downloaded version a restart installs, once there is one; 'change' when it's offered. */
let ready: string | null = null
export const updateOffer = new EventEmitter<{ change: [version: string] }>()

/** The version Restart to Update installs, or null with none downloaded. */
export const readyUpdate = () => ready

const prompts = updatePrompts({
  updater: { check, quitAndInstall: async () => (await loadUpdater()).quitAndInstall() },
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
    // A new version is downloading from 'update-available' until 'update-downloaded'.
    autoUpdater.on('update-available', () => {
      downloading = true
    })
    autoUpdater.on('update-downloaded', (info) => {
      downloading = false
      prompts.downloaded(info.version)
    })
    autoUpdater.on('error', (error) => {
      // A failed check isn't counted (being offline is normal), only a download that failed.
      if (downloading) countFailed('download')
      downloading = false
      failed(error)
    })
    // On a Mac, electron-updater hands each download to Squirrel.Mac, Electron's own updater,
    // which installs it. Only Squirrel.Mac's events say whether a restart can happen. On Linux
    // they never fire: electron-updater replaces the AppImage itself when Gui restarts.
    squirrel.on('update-downloaded', () => prompts.installReady())
    squirrel.on('error', (error) => {
      countFailed('install')
      prompts.installFailed(error)
    })
    return autoUpdater
  })
  return updater
}

/** A version was found and is downloading. */
let downloading = false
/** The stages usage data has counted a failure at this launch: once each. */
const counted = new Set<'download' | 'install'>()

function countFailed(stage: 'download' | 'install') {
  if (counted.has(stage)) return
  counted.add(stage)
  track('update_failed', { stage })
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
  void check()
  setInterval(() => void check(), CHECK_EVERY).unref()
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
  if (!updatesItself && IS_WINDOWS) {
    await dialog.showMessageBox({
      message: 'Gui for Windows doesn’t update itself yet',
      detail: 'Install the newest version over this one to update it.',
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

async function check() {
  let autoUpdater: AppUpdater
  try {
    autoUpdater = await loadUpdater()
  } catch (error) {
    updater = null
    failed(error instanceof Error ? error : new Error(String(error)))
    return null
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    // The download it starts (`autoDownload`) rejects when it fails, as on a dropped
    // connection; the 'error' event has said so already, and nothing else waits on it.
    result?.downloadPromise?.catch(() => undefined)
    return result
  } catch {
    // Reported through the 'error' event.
    return null
  }
}
