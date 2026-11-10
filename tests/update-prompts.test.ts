import { describe, expect, test } from 'bun:test'
import { type UpdateCheck, updatePrompts } from '../src/main/update-prompts'

const OFFER = {
  message: 'Gui 1.1.0 is ready',
  detail: 'Restart now to use it, or it installs the next time you quit Gui.',
  buttons: ['Restart Now', 'Later'],
  defaultId: 0,
  cancelId: 1,
}
const COULD_NOT = {
  message: 'Gui couldn’t restart to install version 1.1.0',
  detail:
    'You’re still using version 1.0.0. To get version 1.1.0, download it from https://usegui.com/download.',
}
const MOVE = {
  message: 'Gui 1.1.0 is ready',
  detail: 'To update, move Gui to your Applications folder and open it from there.',
}

const available = (version: string): UpdateCheck => ({
  isUpdateAvailable: true,
  updateInfo: { version },
})

/** The prompts over a fake updater and a fake dialog, which picks `state.pick` when asked. */
function setup({ inApplications = true } = {}) {
  const shown: Array<{ message: string; detail: string; buttons?: string[] }> = []
  const errors: string[][] = []
  /** What `afterRestartWait` was given: calling one is the wait running out. */
  const waits: Array<() => void> = []
  /** Dialogs left open by `state.hold`: calling one answers it. */
  const open: Array<() => void> = []
  const state = {
    pick: 'Later',
    hold: false,
    /** What the next check finds; an Error fails it the way electron-updater does. */
    found: null as UpdateCheck | Error | null,
    quits: 0,
    quitError: null as Error | null,
  }
  const prompts = updatePrompts({
    updater: {
      async check() {
        if (!(state.found instanceof Error)) return state.found
        prompts.failed(state.found)
        return null
      },
      quitAndInstall() {
        state.quits++
        if (state.quitError) throw state.quitError
      },
    },
    dialog: {
      showMessageBox(options) {
        shown.push(options)
        const answer = () => ({
          response: options.buttons ? options.buttons.indexOf(state.pick) : 0,
        })
        if (!state.hold) return Promise.resolve(answer())
        return new Promise((resolve) => open.push(() => resolve(answer())))
      },
      showErrorBox: (title, content) => errors.push([title, content]),
    },
    version: () => '1.0.0',
    inApplications: () => inApplications,
    afterRestartWait: (run) => waits.push(run),
  })
  const messages = () => shown.map((box) => box.message)
  return { prompts, shown, messages, errors, waits, open, state }
}

describe('a downloaded update', () => {
  test('is offered when it arrives', async () => {
    const { prompts, shown, state } = setup()
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([OFFER])
    expect(state.quits).toBe(0)
  })

  test('stays quiet after Later, however often the updater says it again', async () => {
    const { prompts, shown, state } = setup()
    await prompts.downloaded('1.1.0')
    // Every later check finds the kept file still good and says "downloaded" again.
    await prompts.downloaded('1.1.0')
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([OFFER])
    expect(state.quits).toBe(0)
  })

  test('is not offered again while its offer is still up', async () => {
    const { prompts, shown, open, state } = setup()
    state.hold = true
    const offered = prompts.downloaded('1.1.0')
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([OFFER])
    open[0]()
    await offered
  })

  test('a newer version after Later is offered once too', async () => {
    const { prompts, messages } = setup()
    await prompts.downloaded('1.1.0')
    await prompts.downloaded('1.2.0')
    await prompts.downloaded('1.2.0')
    expect(messages()).toEqual(['Gui 1.1.0 is ready', 'Gui 1.2.0 is ready'])
  })
})

describe('Check for Updates… by hand', () => {
  test('with nothing new says Gui is up to date', async () => {
    const { prompts, shown, state } = setup()
    state.found = { isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }
    await prompts.checkByHand()
    expect(shown).toEqual([
      { message: 'Gui is up to date', detail: 'You have the latest version, 1.0.0.' },
    ])
  })

  test('with a download in progress says so, then offers it once when it lands', async () => {
    const { prompts, shown, state } = setup()
    state.found = available('1.1.0')
    await prompts.checkByHand()
    const downloading = {
      message: 'Downloading Gui 1.1.0…',
      detail: 'Gui will tell you when it’s ready.',
    }
    expect(shown).toEqual([downloading])
    await prompts.downloaded('1.1.0')
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([downloading, OFFER])
  })

  test('with a download ready offers it again, once for each check', async () => {
    const { prompts, shown, state } = setup()
    await prompts.downloaded('1.1.0')
    state.found = available('1.1.0')
    await prompts.checkByHand()
    // The check itself makes the updater say "downloaded" again.
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([OFFER, OFFER])
    await prompts.checkByHand()
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([OFFER, OFFER, OFFER])
  })

  test('with a newer version than the one that is ready says it is downloading', async () => {
    const { prompts, messages, state } = setup()
    await prompts.downloaded('1.1.0')
    state.found = available('1.2.0')
    await prompts.checkByHand()
    expect(messages()).toEqual(['Gui 1.1.0 is ready', 'Downloading Gui 1.2.0…'])
  })

  test('that fails says why, once, and nothing else', async () => {
    const { prompts, shown, errors, state } = setup()
    state.found = new Error('net::ERR_INTERNET_DISCONNECTED')
    await prompts.checkByHand()
    prompts.failed(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(errors).toEqual([["Couldn't check for updates", 'net::ERR_INTERNET_DISCONNECTED']])
    expect(shown).toEqual([])
  })
})

describe('Restart Now', () => {
  test('restarts, and says nothing when the restart comes', async () => {
    const { prompts, shown, waits, state } = setup()
    state.pick = 'Restart Now'
    prompts.installReady()
    await prompts.downloaded('1.1.0')
    expect(state.quits).toBe(1)
    expect(shown).toEqual([OFFER])
    expect(waits).toHaveLength(1)
  })

  test('says so once when the install fails afterwards', async () => {
    const { prompts, shown, waits, state } = setup()
    state.pick = 'Restart Now'
    await prompts.downloaded('1.1.0')
    expect(state.quits).toBe(1)
    expect(shown).toEqual([OFFER])
    // Squirrel.Mac's failure reaches Gui from it and again through electron-updater.
    const error = new Error('Code signature did not pass validation')
    prompts.installFailed(error)
    prompts.failed(error)
    prompts.installFailed(error)
    for (const run of waits) run()
    expect(shown).toEqual([
      OFFER,
      { ...COULD_NOT, detail: `${COULD_NOT.detail}\n\nCode signature did not pass validation` },
    ])
  })

  test('says so at once when the install failed while the offer was up', async () => {
    const { prompts, shown, waits, open, state } = setup()
    state.pick = 'Restart Now'
    state.hold = true
    const offered = prompts.downloaded('1.1.0')
    // Squirrel.Mac is handed the file just after the offer appears.
    prompts.installFailed(new Error('Code signature did not pass validation'))
    expect(shown).toEqual([OFFER])
    state.hold = false
    open[0]()
    await offered
    expect(state.quits).toBe(1)
    expect(shown).toEqual([
      OFFER,
      { ...COULD_NOT, detail: `${COULD_NOT.detail}\n\nCode signature did not pass validation` },
    ])
    expect(waits).toHaveLength(0)
  })

  test('says so at once when a check by hand offers an install that failed', async () => {
    const { prompts, messages, state } = setup()
    await prompts.downloaded('1.1.0')
    prompts.installFailed(new Error('Code signature did not pass validation'))
    state.pick = 'Restart Now'
    state.found = available('1.1.0')
    await prompts.checkByHand()
    // The check hands Squirrel.Mac the file again, and it fails again.
    await prompts.downloaded('1.1.0')
    prompts.installFailed(new Error('Code signature did not pass validation'))
    expect(state.quits).toBe(1)
    expect(messages()).toEqual([OFFER.message, OFFER.message, COULD_NOT.message])
  })

  test('trusts an update Squirrel.Mac already has over a later failure', async () => {
    const { prompts, shown, waits, state } = setup()
    state.pick = 'Restart Now'
    prompts.installReady()
    prompts.installFailed(new Error('The network connection was lost'))
    await prompts.downloaded('1.1.0')
    expect(state.quits).toBe(1)
    expect(shown).toEqual([OFFER])
    expect(waits).toHaveLength(1)
  })

  test('says so once when nothing happens at all', async () => {
    const { prompts, shown, waits, state } = setup()
    state.pick = 'Restart Now'
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([OFFER])
    waits[0]()
    waits[0]()
    prompts.installFailed(new Error('late'))
    expect(shown).toEqual([OFFER, COULD_NOT])
  })

  test('says so when the updater throws', async () => {
    const { prompts, shown, waits, state } = setup()
    state.pick = 'Restart Now'
    state.quitError = new Error('No update available')
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([
      OFFER,
      { ...COULD_NOT, detail: `${COULD_NOT.detail}\n\nNo update available` },
    ])
    expect(waits).toHaveLength(0)
  })

  test('an old wait does not speak for a newer restart', async () => {
    const { prompts, messages, waits, state } = setup()
    state.pick = 'Restart Now'
    await prompts.downloaded('1.1.0')
    prompts.installFailed(new Error('first try'))
    await prompts.downloaded('1.2.0')
    expect(waits).toHaveLength(2)
    waits[0]()
    expect(messages()).toEqual([OFFER.message, COULD_NOT.message, 'Gui 1.2.0 is ready'])
    waits[1]()
    expect(messages()).toEqual([
      OFFER.message,
      COULD_NOT.message,
      'Gui 1.2.0 is ready',
      'Gui couldn’t restart to install version 1.2.0',
    ])
  })
})

describe('in the background', () => {
  test('a failed check or download stays quiet', () => {
    const { prompts, shown, errors } = setup()
    prompts.failed(new Error('net::ERR_INTERNET_DISCONNECTED'))
    prompts.installFailed(new Error('Code signature did not pass validation'))
    expect(shown).toEqual([])
    expect(errors).toEqual([])
  })

  test('a failure after Later stays quiet', async () => {
    const { prompts, shown, errors } = setup()
    await prompts.downloaded('1.1.0')
    prompts.failed(new Error('net::ERR_INTERNET_DISCONNECTED'))
    prompts.installFailed(new Error('Code signature did not pass validation'))
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([OFFER])
    expect(errors).toEqual([])
  })
})

describe('outside the Applications folder', () => {
  test('says where Gui has to be instead of offering a restart', async () => {
    const { prompts, shown, state } = setup({ inApplications: false })
    state.pick = 'Restart Now'
    await prompts.downloaded('1.1.0')
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([MOVE])
    expect(state.quits).toBe(0)
  })

  test('says it again for a check by hand, and nothing about the failure behind it', async () => {
    const { prompts, shown, errors, state } = setup({ inApplications: false })
    await prompts.downloaded('1.1.0')
    prompts.installFailed(new Error('Cannot update while running on a read-only volume'))
    state.found = available('1.1.0')
    await prompts.checkByHand()
    await prompts.downloaded('1.1.0')
    expect(shown).toEqual([MOVE, MOVE])
    expect(errors).toEqual([])
    expect(state.quits).toBe(0)
  })
})
