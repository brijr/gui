import { describe, expect, test } from 'bun:test'
import { type UpdateCheck, updatePrompts } from '../src/main/update-prompts'

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

/** The prompts over a fake updater and dialog; `offered` is what Restart to Update was shown for. */
function setup({ inApplications = true } = {}) {
  const shown: Array<{ message: string; detail: string; buttons?: string[] }> = []
  const errors: string[][] = []
  const offered: string[] = []
  /** What `afterRestartWait` was given: calling one is the wait running out. */
  const waits: Array<() => void> = []
  const state = {
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
        return Promise.resolve({ response: 0 })
      },
      showErrorBox: (title, content) => errors.push([title, content]),
    },
    version: () => '1.0.0',
    inApplications: () => inApplications,
    afterRestartWait: (run) => waits.push(run),
    offer: (version) => offered.push(version),
  })
  const messages = () => shown.map((box) => box.message)
  return { prompts, shown, messages, errors, offered, waits, state }
}

describe('a downloaded update', () => {
  test('is offered quietly when it arrives, with no dialog', () => {
    const { prompts, shown, offered, state } = setup()
    prompts.downloaded('1.1.0')
    expect(offered).toEqual(['1.1.0'])
    expect(shown).toEqual([])
    expect(state.quits).toBe(0)
  })

  test('is offered once, however often the updater says it again', () => {
    const { prompts, offered } = setup()
    // Every later check finds the kept file still good and says "downloaded" again.
    prompts.downloaded('1.1.0')
    prompts.downloaded('1.1.0')
    prompts.downloaded('1.1.0')
    expect(offered).toEqual(['1.1.0'])
  })

  test('a newer version is offered once too', () => {
    const { prompts, offered } = setup()
    prompts.downloaded('1.1.0')
    prompts.downloaded('1.2.0')
    prompts.downloaded('1.2.0')
    expect(offered).toEqual(['1.1.0', '1.2.0'])
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

  test('with a new version downloads it without a dialog, and offers it when it lands', async () => {
    const { prompts, shown, offered, state } = setup()
    state.found = available('1.1.0')
    await prompts.checkByHand()
    expect(shown).toEqual([])
    prompts.downloaded('1.1.0')
    prompts.downloaded('1.1.0')
    expect(offered).toEqual(['1.1.0'])
    expect(shown).toEqual([])
  })

  test('with a download ready asks nothing: Restart to Update is already there', async () => {
    const { prompts, shown, offered, state } = setup()
    prompts.downloaded('1.1.0')
    state.found = available('1.1.0')
    await prompts.checkByHand()
    prompts.downloaded('1.1.0')
    expect(shown).toEqual([])
    expect(offered).toEqual(['1.1.0'])
  })

  test('that fails says why, once, and nothing else', async () => {
    const { prompts, shown, errors, state } = setup()
    state.found = new Error('net::ERR_INTERNET_DISCONNECTED')
    await prompts.checkByHand()
    prompts.failed(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(errors).toEqual([['Couldn’t check for updates', 'net::ERR_INTERNET_DISCONNECTED']])
    expect(shown).toEqual([])
  })
})

describe('Restart to Update', () => {
  test('does nothing with no version downloaded', async () => {
    const { prompts, shown, state } = setup()
    await prompts.restartToUpdate()
    expect(state.quits).toBe(0)
    expect(shown).toEqual([])
  })

  test('restarts, and says nothing when the restart comes', async () => {
    const { prompts, shown, waits, state } = setup()
    prompts.installReady()
    prompts.downloaded('1.1.0')
    await prompts.restartToUpdate()
    expect(state.quits).toBe(1)
    expect(shown).toEqual([])
    expect(waits).toHaveLength(1)
  })

  test('says so once when the install fails afterwards', async () => {
    const { prompts, shown, waits, state } = setup()
    prompts.downloaded('1.1.0')
    await prompts.restartToUpdate()
    expect(state.quits).toBe(1)
    // Squirrel.Mac's failure reaches Gui from it and again through electron-updater.
    const error = new Error('Code signature did not pass validation')
    prompts.installFailed(error)
    prompts.failed(error)
    prompts.installFailed(error)
    for (const run of waits) run()
    expect(shown).toEqual([
      { ...COULD_NOT, detail: `${COULD_NOT.detail}\n\nCode signature did not pass validation` },
    ])
  })

  test('says so at once when the install had already failed', async () => {
    const { prompts, shown, waits, state } = setup()
    prompts.downloaded('1.1.0')
    // Squirrel.Mac is handed the file just after it's offered.
    prompts.installFailed(new Error('Code signature did not pass validation'))
    expect(shown).toEqual([])
    await prompts.restartToUpdate()
    expect(state.quits).toBe(1)
    expect(shown).toEqual([
      { ...COULD_NOT, detail: `${COULD_NOT.detail}\n\nCode signature did not pass validation` },
    ])
    expect(waits).toHaveLength(0)
  })

  test('trusts an update Squirrel.Mac already has over a later failure', async () => {
    const { prompts, shown, waits, state } = setup()
    prompts.installReady()
    prompts.installFailed(new Error('The network connection was lost'))
    prompts.downloaded('1.1.0')
    await prompts.restartToUpdate()
    expect(state.quits).toBe(1)
    expect(shown).toEqual([])
    expect(waits).toHaveLength(1)
  })

  test('says so once when nothing happens at all', async () => {
    const { prompts, shown, waits } = setup()
    prompts.downloaded('1.1.0')
    await prompts.restartToUpdate()
    waits[0]()
    waits[0]()
    prompts.installFailed(new Error('late'))
    expect(shown).toEqual([COULD_NOT])
  })

  test('says so when the updater throws', async () => {
    const { prompts, shown, waits, state } = setup()
    state.quitError = new Error('No update available')
    prompts.downloaded('1.1.0')
    await prompts.restartToUpdate()
    expect(shown).toEqual([{ ...COULD_NOT, detail: `${COULD_NOT.detail}\n\nNo update available` }])
    expect(waits).toHaveLength(0)
  })

  test('an old wait does not speak for a newer restart', async () => {
    const { prompts, messages, waits } = setup()
    prompts.downloaded('1.1.0')
    await prompts.restartToUpdate()
    prompts.installFailed(new Error('first try'))
    prompts.downloaded('1.2.0')
    await prompts.restartToUpdate()
    expect(waits).toHaveLength(2)
    waits[0]()
    expect(messages()).toEqual([COULD_NOT.message])
    waits[1]()
    expect(messages()).toEqual([COULD_NOT.message, 'Gui couldn’t restart to install version 1.2.0'])
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

  test('a failure after an update is offered stays quiet', () => {
    const { prompts, shown, errors } = setup()
    prompts.downloaded('1.1.0')
    prompts.failed(new Error('net::ERR_INTERNET_DISCONNECTED'))
    prompts.installFailed(new Error('Code signature did not pass validation'))
    prompts.downloaded('1.1.0')
    expect(shown).toEqual([])
    expect(errors).toEqual([])
  })
})

describe('outside the Applications folder', () => {
  test('Restart to Update says where Gui has to be instead of restarting', async () => {
    const { prompts, shown, offered, state } = setup({ inApplications: false })
    prompts.downloaded('1.1.0')
    expect(offered).toEqual(['1.1.0'])
    expect(shown).toEqual([])
    await prompts.restartToUpdate()
    expect(shown).toEqual([MOVE])
    expect(state.quits).toBe(0)
  })
})
