/** What a check found: as much of electron-updater's result as the schedule reads. */
export interface ScheduledCheck {
  isUpdateAvailable: boolean
  updateInfo: { version: string }
  /**
   * The download this check started (`autoDownload`). While one runs, every check gets the
   * same promise back (AppUpdater.js:442). It settles once the file is downloaded and, on a
   * Mac, Squirrel.Mac has fetched it from electron-updater (MacUpdater.js:184, :221).
   */
  downloadPromise?: Promise<unknown> | null
}

export type UpdateStage = 'download' | 'install'

export interface UpdateScheduleOptions {
  /** One check with electron-updater; rejects when it fails. Null when the updater is off. */
  check(): Promise<ScheduledCheck | null>
  /**
   * Whether a downloaded file goes on to Squirrel.Mac, which says when it has the update
   * (`installReady`) or couldn't take it (`installFailed`). Linux's AppImage has no such step.
   */
  handsOff: boolean
  /** Wall-clock time in ms, which keeps counting while the computer sleeps. */
  now(): number
  /** Runs `run` after `ms`, without keeping Gui alive; the result cancels it. */
  setTimer(run: () => void, ms: number): () => void
  /** Counts a failed stage in usage data; the schedule calls it at most once per stage. */
  countFailed(stage: UpdateStage, error: unknown): void
}

/** How often a running Gui looks for a new version, after the check at launch. */
export const CHECK_EVERY = 4 * 60 * 60 * 1000
/** How soon Gui tries again after a failed check or download: then every CHECK_EVERY. */
export const RETRY_AFTER = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]
/** Waking the computer checks only when the last check is at least this old. */
export const MIN_GAP = 60 * 1000
/** How long a hand-off to Squirrel.Mac may go without a word before Gui stops waiting for it. */
export const HAND_OFF_WAIT = 10 * 60 * 1000

/** One download, from the check that started it until it's installable or has failed. */
interface Download {
  version: string
  promise: Promise<unknown>
  /** electron-updater has the file and said so; anything that fails now is the install. */
  downloaded: boolean
  /** The promise resolved; on a Mac, Squirrel.Mac's word is still to come. */
  fetched: boolean
  /** What Squirrel.Mac said about it, if it spoke before the promise settled */
  installed: { error: unknown } | null
  cancelWait: (() => void) | null
}

/**
 * When Gui checks for updates, and what it counts when one fails; `updates.ts` wires it to
 * electron-updater and Electron.
 *
 * - At launch, then CHECK_EVERY after the last check settles.
 * - After a failed check or download, again after 1, 5 and 15 minutes (RETRY_AFTER), then every
 *   CHECK_EVERY; a download that lands, or a check that finds nothing new, starts over. A check
 *   that starts a download doesn't, so a download that keeps failing can't loop.
 * - When the computer wakes (timers don't count sleep, and the network may be new), unless the
 *   last check was under MIN_GAP ago. Once a version is downloaded and installable, a wake only
 *   checks when the last check is CHECK_EVERY old, since each check hands the same file to
 *   Squirrel.Mac again; the regular timer still runs, so a newer release is still found.
 * - Never while a check is running, or while a download or its hand-off to Squirrel.Mac is (a
 *   second hand-off makes Squirrel.Mac fail). A check by hand joins one already running.
 * - Never after Gui starts to quit (`stop`).
 */
export function updateSchedule(options: UpdateScheduleOptions) {
  let stopped = false
  let running: Promise<ScheduledCheck | null> | null = null
  let lastCheck: number | null = null
  let download: Download | null = null
  /** Failures in a row, for RETRY_AFTER */
  let failures = 0
  /** The version that's downloaded and installable: Squirrel.Mac has it, or the AppImage file is ready */
  let held: string | null = null
  /** The version electron-updater last said it had downloaded */
  let lastDownloaded: string | null = null
  let cancelTimer: (() => void) | null = null
  const counted = new Set<UpdateStage>()

  function count(stage: UpdateStage, error: unknown) {
    if (counted.has(stage)) return
    counted.add(stage)
    options.countFailed(stage, error)
  }

  /** The next timed check, replacing the one set before. */
  function after(ms: number) {
    cancelTimer?.()
    cancelTimer = null
    if (stopped) return
    cancelTimer = options.setTimer(() => {
      cancelTimer = null
      if (!automatic('timer')) after(CHECK_EVERY)
    }, ms)
  }

  function failed() {
    failures++
    after(RETRY_AFTER[failures - 1] ?? CHECK_EVERY)
  }

  function succeeded() {
    failures = 0
    after(CHECK_EVERY)
  }

  /** Starts a check unless one shouldn't start now; says whether it did. */
  function automatic(reason: 'launch' | 'timer' | 'wake') {
    if (stopped || running || download) return false
    if (reason === 'wake' && lastCheck !== null) {
      const gap = held ? CHECK_EVERY : MIN_GAP
      if (options.now() - lastCheck < gap) return false
    }
    void run()
    return true
  }

  function run() {
    lastCheck = options.now()
    // Started on a later tick, so `running` is set before anything can clear it.
    const attempt = Promise.resolve()
      .then(() => options.check())
      .then(
        (result) => {
          running = null
          if (result?.downloadPromise) follow(result.updateInfo.version, result.downloadPromise)
          else succeeded()
          return result
        },
        () => {
          running = null
          // Being offline is normal, so it isn't counted; RETRY_AFTER is the most it costs.
          failed()
          return null
        },
      )
    running = attempt
    return attempt
  }

  /** Waits for a download a check started; until it ends no check starts on its own. */
  function follow(version: string, promise: Promise<unknown>) {
    if (download?.promise === promise) return
    const current: Download = {
      version,
      promise,
      downloaded: false,
      fetched: false,
      installed: null,
      cancelWait: null,
    }
    download = current
    // In case the download never settles: the timer only checks once it's over.
    after(CHECK_EVERY)
    promise.then(
      () => {
        if (download !== current) return
        current.fetched = true
        if (!options.handsOff) return end(current, null)
        if (current.installed) return end(current, current.installed.error)
        current.cancelWait = options.setTimer(() => {
          // Squirrel.Mac said nothing; stop waiting, without calling it a failure.
          if (download !== current) return
          download = null
          after(CHECK_EVERY)
        }, HAND_OFF_WAIT)
      },
      (error: unknown) => {
        if (download !== current) return
        // Once the file was downloaded, what failed is the hand-off to Squirrel.Mac; its own
        // 'error' has usually been counted as the install already.
        count(current.downloaded ? 'install' : 'download', error)
        end(current, error ?? new Error('Update failed'))
      },
    )
  }

  /** A download is over: installable (`error` null) or failed. */
  function end(current: Download, error: unknown) {
    current.cancelWait?.()
    download = null
    if (error) return failed()
    held = current.version
    succeeded()
  }

  return {
    /** At launch: the first check, then the rest on their own. */
    start() {
      automatic('launch')
    },

    /** The computer woke up. */
    resumed() {
      automatic('wake')
    },

    /** Gui is quitting: nothing checks again. */
    stop() {
      stopped = true
      cancelTimer?.()
      cancelTimer = null
    },

    /** Check for Updates… by hand: joins a check already running. Null when it failed. */
    checkByHand(): Promise<ScheduledCheck | null> {
      return running ?? run()
    },

    /** The version downloading or being handed to Squirrel.Mac, which a check would only interrupt */
    downloading(): string | null {
      return download?.version ?? null
    },

    /** electron-updater has this version's file, and (on a Mac) hands it to Squirrel.Mac next. */
    downloaded(version: string) {
      lastDownloaded = version
      if (download?.version === version) download.downloaded = true
    },

    /** Squirrel.Mac has the update. */
    installReady() {
      const current = download
      if (!current?.downloaded) {
        held = lastDownloaded
        return
      }
      if (current.fetched) end(current, null)
      else current.installed = { error: null }
    },

    /** Squirrel.Mac couldn't take the update, or couldn't install it. */
    installFailed(error: Error) {
      count('install', error)
      const current = download
      if (!current?.downloaded) return
      if (current.fetched) end(current, error)
      else current.installed = { error }
    },
  }
}
