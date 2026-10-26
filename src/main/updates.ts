import { app, dialog } from 'electron'
import type { AppUpdater } from 'electron-updater'

/** How often a running Gui looks for a new version, after the check at launch. */
const CHECK_EVERY = 4 * 60 * 60 * 1000

let checkingByHand = false
let prompted = false
let updater: Promise<AppUpdater> | null = null

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
    autoUpdater.on('update-downloaded', (info) => void offerRestart(info.version))
    autoUpdater.on('error', failed)
    return autoUpdater
  })
  return updater
}

function failed(error: Error) {
  console.error('Update failed:', error)
  if (!checkingByHand) return
  checkingByHand = false
  dialog.showErrorBox("Couldn't check for updates", error.message)
}

/**
 * Keeps an installed Gui up to date from the feed in electron-builder.yml (`publish`). New
 * versions download in the background; once one is ready Gui offers to restart into it, and
 * otherwise installs it when the user next quits. Squirrel.Mac only applies an update signed
 * by the same Developer ID, so dev and ad-hoc builds never check.
 */
export function startUpdates() {
  if (!app.isPackaged) return
  void check()
  setInterval(() => void check(), CHECK_EVERY).unref()
}

/** Gui → Check for Updates…: says what it found, unlike the quiet background checks. */
export async function checkForUpdatesByHand() {
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      message: 'Updates are off in development builds',
      detail: 'Pull the latest main and rebuild instead.',
    })
    return
  }
  checkingByHand = true
  const result = await check()
  if (!checkingByHand) return
  checkingByHand = false
  if (!result?.isUpdateAvailable) {
    await dialog.showMessageBox({
      message: 'Gui is up to date',
      detail: `You have the latest version, ${app.getVersion()}.`,
    })
  } else if (!prompted) {
    await dialog.showMessageBox({
      message: `Downloading Gui ${result.updateInfo.version}…`,
      detail: 'Gui will offer to restart when it’s ready.',
    })
  } else {
    await offerRestart(result.updateInfo.version)
  }
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
    return await autoUpdater.checkForUpdates()
  } catch {
    // Reported through the 'error' event.
    return null
  }
}

async function offerRestart(version: string) {
  prompted = true
  const { response } = await dialog.showMessageBox({
    message: `Gui ${version} is ready`,
    detail: 'Restart now to use it, or it installs the next time you quit Gui.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) (await loadUpdater()).quitAndInstall()
}
