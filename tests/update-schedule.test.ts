import { describe, expect, test } from 'bun:test'
import {
  CHECK_EVERY,
  HAND_OFF_WAIT,
  MIN_GAP,
  type ScheduledCheck,
  type UpdateStage,
  updateSchedule,
} from '../src/main/update-schedule'

const MINUTE = 60 * 1000

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** Lets every promise callback that's ready run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * The schedule over fake timers, a fake clock, and a fake electron-updater whose checks and
 * downloads the test settles by hand.
 */
function setup({ handsOff = true } = {}) {
  let clock = 1_000_000
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  const checks: Array<Deferred<ScheduledCheck | null>> = []
  const counted: Array<[UpdateStage, unknown]> = []
  const schedule = updateSchedule({
    check() {
      const check = deferred<ScheduledCheck | null>()
      checks.push(check)
      return check.promise
    },
    handsOff,
    now: () => clock,
    setTimer(run, ms) {
      const timer = { at: clock + ms, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    countFailed: (stage, error) => counted.push([stage, error]),
  })

  /** Time passes while Gui is awake: due timers run in order. */
  async function awake(ms: number) {
    await settle()
    const until = clock + ms
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= until)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clock = due.at
      due.cancelled = true
      due.run()
      await settle()
    }
    clock = until
    await settle()
  }

  /** Time passes while the computer sleeps: the wall clock moves, timers don't. */
  function asleep(ms: number) {
    clock += ms
    for (const timer of timers) timer.at += ms
  }

  /** The check the schedule last started */
  const latest = () => checks[checks.length - 1]
  const pending = () => timers.filter((timer) => !timer.cancelled)

  async function nothingNew() {
    latest().resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
    await settle()
  }
  async function checkFails() {
    latest().reject(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await settle()
  }
  /** The latest check finds `version` and starts downloading it; returns the download. */
  async function finds(version: string) {
    const download = deferred<unknown>()
    latest().resolve({
      isUpdateAvailable: true,
      updateInfo: { version },
      downloadPromise: download.promise,
    })
    await settle()
    return download
  }
  /** The download lands, electron-updater hands it to Squirrel.Mac, and Squirrel takes it. */
  async function lands(download: Deferred<unknown>, version: string) {
    schedule.downloaded(version)
    download.resolve([])
    await settle()
    if (handsOff) schedule.installReady()
    await settle()
  }

  return {
    schedule,
    checks,
    counted,
    awake,
    asleep,
    pending,
    nothingNew,
    checkFails,
    finds,
    lands,
  }
}

describe('when Gui checks', () => {
  test('at launch, then every four hours', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    expect(t.checks).toHaveLength(1)
    await t.nothingNew()
    await t.awake(CHECK_EVERY - 1)
    expect(t.checks).toHaveLength(1)
    await t.awake(1)
    expect(t.checks).toHaveLength(2)
    await t.nothingNew()
    await t.awake(CHECK_EVERY)
    expect(t.checks).toHaveLength(3)
    // One timer at a time, never a pile of them.
    expect(t.pending()).toHaveLength(0)
    await t.nothingNew()
    expect(t.pending()).toHaveLength(1)
  })

  test('when the computer wakes, at most once a minute', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    await t.nothingNew()
    t.asleep(30 * 1000)
    t.schedule.resumed()
    await settle()
    expect(t.checks).toHaveLength(1)
    t.asleep(MIN_GAP)
    t.schedule.resumed()
    t.schedule.resumed()
    await settle()
    expect(t.checks).toHaveLength(2)
    await t.nothingNew()
    t.schedule.resumed()
    await settle()
    expect(t.checks).toHaveLength(2)
  })

  test('a wake during a check does not start another', async () => {
    const t = setup()
    t.schedule.start()
    t.asleep(10 * MINUTE)
    t.schedule.resumed()
    await settle()
    expect(t.checks).toHaveLength(1)
  })

  test('a check by hand joins the one running', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const byHand = t.schedule.checkByHand()
    await settle()
    expect(t.checks).toHaveLength(1)
    await t.nothingNew()
    expect(await byHand).toEqual({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
  })

  test('a check by hand that fails answers null, and is not counted', async () => {
    const t = setup()
    const byHand = t.schedule.checkByHand()
    await settle()
    await t.checkFails()
    expect(await byHand).toBeNull()
    expect(t.counted).toEqual([])
  })

  test('the timer replaces the check at launch rather than adding to it', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    await t.nothingNew()
    const byHand = t.schedule.checkByHand()
    await settle()
    await t.nothingNew()
    await byHand
    // The check by hand moved the next one to four hours after it.
    expect(t.pending()).toHaveLength(1)
  })
})

describe('after a failure', () => {
  test('a failed download tries again after 1, 5 and 15 minutes, then every four hours', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const times: number[] = []
    let download = await t.finds('1.1.0')
    for (let i = 0; i < 5; i++) {
      download.reject(new Error('net::ERR_CONNECTION_RESET'))
      await settle()
      const before = t.checks.length
      let waited = 0
      while (t.checks.length === before) {
        await t.awake(MINUTE)
        waited += MINUTE
      }
      times.push(waited)
      download = await t.finds('1.1.0')
    }
    expect(times).toEqual([MINUTE, 5 * MINUTE, 15 * MINUTE, CHECK_EVERY, CHECK_EVERY])
    // Once per launch.
    expect(t.counted.map(([stage]) => stage)).toEqual(['download'])
  })

  test('starts over once a download lands', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    let download = await t.finds('1.1.0')
    download.reject(new Error('net::ERR_CONNECTION_RESET'))
    await t.awake(MINUTE)
    download = await t.finds('1.1.0')
    download.reject(new Error('net::ERR_CONNECTION_RESET'))
    await t.awake(5 * MINUTE)
    download = await t.finds('1.1.0')
    await t.lands(download, '1.1.0')
    // A newer version, four hours later, whose download fails: back to a minute.
    await t.awake(CHECK_EVERY)
    expect(t.checks).toHaveLength(4)
    download = await t.finds('1.2.0')
    download.reject(new Error('net::ERR_CONNECTION_RESET'))
    await settle()
    await t.awake(MINUTE)
    expect(t.checks).toHaveLength(5)
  })

  test('a failed check while offline does not loop', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        if (t.checks.length > 0 && t.pending().length === 0) await t.checkFails()
        await t.awake(MINUTE)
      }
    }
    if (t.pending().length === 0) await t.checkFails()
    // At launch, three retries, then every four hours.
    expect(t.checks.length).toBeLessThanOrEqual(1 + 3 + 6)
    expect(t.checks.length).toBeGreaterThanOrEqual(1 + 3 + 5)
    expect(t.counted).toEqual([])
  })

  test('a failed check retries soon, so a wake onto a slow network still finds it', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    await t.nothingNew()
    t.asleep(8 * 60 * MINUTE)
    t.schedule.resumed()
    await settle()
    expect(t.checks).toHaveLength(2)
    await t.checkFails()
    await t.awake(MINUTE)
    expect(t.checks).toHaveLength(3)
  })
})

describe('while downloading', () => {
  test('nothing checks on its own until the download and its hand-off are over', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    expect(t.schedule.downloading()).toBe('1.1.0')
    t.asleep(10 * MINUTE)
    t.schedule.resumed()
    await t.awake(CHECK_EVERY * 2)
    expect(t.checks).toHaveLength(1)
    // Downloaded; Squirrel.Mac has fetched it but not said it has the update.
    t.schedule.downloaded('1.1.0')
    download.resolve([])
    await settle()
    expect(t.schedule.downloading()).toBe('1.1.0')
    t.asleep(10 * MINUTE)
    t.schedule.resumed()
    await settle()
    expect(t.checks).toHaveLength(1)
    t.schedule.installReady()
    expect(t.schedule.downloading()).toBeNull()
    await t.awake(CHECK_EVERY)
    expect(t.checks).toHaveLength(2)
  })

  test('a hand-off Squirrel.Mac never answers stops holding checks back', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    t.schedule.downloaded('1.1.0')
    download.resolve([])
    await settle()
    await t.awake(HAND_OFF_WAIT)
    expect(t.schedule.downloading()).toBeNull()
    expect(t.counted).toEqual([])
  })

  test('on Linux a download is over once the file is there', async () => {
    const t = setup({ handsOff: false })
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    t.schedule.downloaded('1.1.0')
    download.resolve([])
    await settle()
    expect(t.schedule.downloading()).toBeNull()
    await t.awake(CHECK_EVERY)
    expect(t.checks).toHaveLength(2)
  })

  test('a check by hand that finds the same download does not start another', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    const byHand = t.schedule.checkByHand()
    await settle()
    t.checks[1].resolve({
      isUpdateAvailable: true,
      updateInfo: { version: '1.1.0' },
      downloadPromise: download.promise,
    })
    await byHand
    expect(t.schedule.downloading()).toBe('1.1.0')
    download.reject(new Error('net::ERR_CONNECTION_RESET'))
    await settle()
    expect(t.counted.map(([stage]) => stage)).toEqual(['download'])
  })
})

describe('once a version is downloaded', () => {
  test('a wake does not hand it to Squirrel.Mac again, but a newer release is still found', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    let download = await t.finds('1.1.0')
    await t.lands(download, '1.1.0')
    // Many short sleeps: none of them checks.
    for (let i = 0; i < 6; i++) {
      t.asleep(20 * MINUTE)
      t.schedule.resumed()
      await t.awake(10 * MINUTE)
    }
    expect(t.checks).toHaveLength(1)
    // Four hours on, the timer checks and finds a newer version.
    await t.awake(CHECK_EVERY)
    expect(t.checks).toHaveLength(2)
    download = await t.finds('1.2.0')
    expect(t.schedule.downloading()).toBe('1.2.0')
    await t.lands(download, '1.2.0')
    expect(t.schedule.downloading()).toBeNull()
  })

  test('a wake checks when the last check is four hours old, counting sleep', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    await t.lands(download, '1.1.0')
    t.asleep(CHECK_EVERY)
    t.schedule.resumed()
    await settle()
    expect(t.checks).toHaveLength(2)
  })

  test('the same version found again is handed off again, and stays quiet', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    let download = await t.finds('1.1.0')
    await t.lands(download, '1.1.0')
    await t.awake(CHECK_EVERY)
    download = await t.finds('1.1.0')
    await t.lands(download, '1.1.0')
    expect(t.schedule.downloading()).toBeNull()
    expect(t.counted).toEqual([])
  })
})

describe('counting failures', () => {
  test('a failed hand-off to Squirrel.Mac counts as the install, once', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    t.schedule.downloaded('1.1.0')
    // Squirrel.Mac's own 'error', then the download promise electron-updater rejects with it.
    const error = new Error('Code signature did not pass validation')
    t.schedule.installFailed(error)
    download.reject(error)
    await settle()
    expect(t.counted).toEqual([['install', error]])
    expect(t.schedule.downloading()).toBeNull()
    // And it tries again soon.
    await t.awake(MINUTE)
    expect(t.checks).toHaveLength(2)
  })

  test('Squirrel.Mac failing after the hand-off ends it as a failure', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    t.schedule.downloaded('1.1.0')
    download.resolve([])
    await settle()
    t.schedule.installFailed(new Error('The command is disabled and cannot be executed'))
    expect(t.schedule.downloading()).toBeNull()
    expect(t.counted.map(([stage]) => stage)).toEqual(['install'])
    await t.awake(MINUTE)
    expect(t.checks).toHaveLength(2)
  })

  test('a download and an install failure each count once per launch', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    let download = await t.finds('1.1.0')
    download.reject(new Error('net::ERR_CONNECTION_RESET'))
    await t.awake(MINUTE)
    download = await t.finds('1.1.0')
    download.reject(new Error('Request timed out'))
    await t.awake(5 * MINUTE)
    download = await t.finds('1.1.0')
    t.schedule.downloaded('1.1.0')
    download.reject(new Error('Cannot pipe'))
    await settle()
    t.schedule.installFailed(new Error('later'))
    expect(t.counted.map(([stage]) => stage)).toEqual(['download', 'install'])
  })

  test('a failed check is never counted, even during a download', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    const byHand = t.schedule.checkByHand()
    await settle()
    await t.checkFails()
    await byHand
    expect(t.counted).toEqual([])
    // The download is still followed, and its own failure still counts.
    expect(t.schedule.downloading()).toBe('1.1.0')
    download.reject(new Error('net::ERR_CONNECTION_RESET'))
    await settle()
    expect(t.counted.map(([stage]) => stage)).toEqual(['download'])
  })
})

describe('once Gui starts to quit', () => {
  test('nothing checks again', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    await t.nothingNew()
    t.schedule.stop()
    expect(t.pending()).toHaveLength(0)
    t.asleep(CHECK_EVERY * 2)
    t.schedule.resumed()
    await t.awake(CHECK_EVERY * 2)
    expect(t.checks).toHaveLength(1)
  })

  test('a check or download that ends afterwards sets no timer', async () => {
    const t = setup()
    t.schedule.start()
    await settle()
    const download = await t.finds('1.1.0')
    t.schedule.stop()
    download.reject(new Error('net::ERR_CONNECTION_RESET'))
    await settle()
    expect(t.pending()).toHaveLength(0)
    await t.awake(CHECK_EVERY)
    expect(t.checks).toHaveLength(1)
  })
})
