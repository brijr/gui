/** What a check found: as much of electron-updater's result as the prompts read. */
export interface UpdateCheck {
  isUpdateAvailable: boolean
  updateInfo: { version: string }
}

export interface UpdatePromptsOptions {
  updater: {
    /** Null when the check failed, which `failed` has already been told. */
    check(): Promise<UpdateCheck | null>
    quitAndInstall(): void | Promise<void>
  }
  dialog: {
    showMessageBox(options: {
      message: string
      detail: string
      buttons?: string[]
      defaultId?: number
      cancelId?: number
    }): Promise<{ response: number }>
    showErrorBox(title: string, content: string): void
  }
  /** The version that's running */
  version(): string
  /** Squirrel.Mac can't replace a Gui run from its disk image or from Downloads. */
  inApplications(): boolean
  /** Calls `run` once a restart has had long enough to happen; must not keep Gui alive. */
  afterRestartWait(run: () => void): void
  /**
   * The version a restart installs, for the quiet Restart to Update item (app menu, window
   * chrome). Nothing pops up for it.
   */
  offer(version: string): void
}

const NOT_IN_APPLICATIONS =
  'To update, move Gui to your Applications folder and open it from there.'

/**
 * When Gui speaks up about an update, and what it says; `updates.ts` does the updating.
 *
 * electron-updater downloads a version, says so, and only then hands the file to Squirrel.Mac
 * (Electron's own updater), which is what installs it. It says "downloaded" again on every
 * later check, because the file it kept is still good. So a version is offered once, quietly
 * (`offer`: a Restart to Update item, never a dialog), and a restart counts on Squirrel.Mac:
 * if that fails, the restart never comes, and Gui says so.
 */
export function updatePrompts(options: UpdatePromptsOptions) {
  const { updater, dialog } = options
  /** The downloaded version, which has been offered */
  let ready: string | null = null
  let checkingByHand = false
  /** Squirrel.Mac has an update, so a restart installs it at once. */
  let installable = false
  /** Why Squirrel.Mac couldn't take the download it was last handed */
  let installError: Error | null = null
  /** The restart the user chose, until Gui quits or says it couldn't */
  let restarting: { version: string } | null = null

  async function restart(version: string) {
    const attempt = { version }
    restarting = attempt
    try {
      await updater.quitAndInstall()
    } catch (error) {
      await couldNotRestart(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // Squirrel.Mac has already failed, so the restart is waiting for something that won't come.
    if (!installable && installError) return couldNotRestart(installError)
    options.afterRestartWait(() => {
      if (restarting === attempt) void couldNotRestart()
    })
  }

  /** Says so once for each restart the user chose. */
  async function couldNotRestart(reason?: Error) {
    if (!restarting) return
    const { version } = restarting
    restarting = null
    const todo = `You’re still using version ${options.version()}. To get version ${version}, download it from https://usegui.com/download.`
    await dialog.showMessageBox({
      message: `Gui couldn’t restart to install version ${version}`,
      detail: reason ? `${todo}\n\n${reason.message}` : todo,
    })
  }

  return {
    /** electron-updater has this version's file. It says so again on every later check. */
    downloaded(version: string) {
      // Squirrel.Mac is handed the file again each time.
      installError = null
      if (version === ready) return
      ready = version
      options.offer(version)
    },

    /** Restart to Update: the user chose to restart into the version offered. */
    async restartToUpdate() {
      if (!ready) return
      if (!options.inApplications()) {
        await dialog.showMessageBox({
          message: `Gui ${ready} is ready`,
          detail: NOT_IN_APPLICATIONS,
        })
        return
      }
      await restart(ready)
    },

    /** Squirrel.Mac has the update too. */
    installReady() {
      installable = true
      installError = null
    },

    /** Squirrel.Mac couldn't take the update, or couldn't restart into it. */
    installFailed(error: Error) {
      if (!installable) installError = error
      void couldNotRestart(error)
    },

    /** A check or a download failed. Only a check by hand says so. */
    failed(error: Error) {
      if (!checkingByHand) return
      checkingByHand = false
      dialog.showErrorBox('Couldn’t check for updates', error.message)
    },

    /**
     * Gui → Check for Updates…: says when Gui is up to date or the check failed. A new version
     * downloads quietly and is offered (`offer`) when it's ready, like a background check's.
     */
    async checkByHand() {
      checkingByHand = true
      const result = await updater.check()
      // `failed` has said why.
      if (!checkingByHand) return
      checkingByHand = false
      if (!result?.isUpdateAvailable) {
        await dialog.showMessageBox({
          message: 'Gui is up to date',
          detail: `You have the latest version, ${options.version()}.`,
        })
      }
    },
  }
}
