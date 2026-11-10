import { describe, expect, test } from 'bun:test'
import { AgentViewport, viewportForWidth } from '../src/main/agent-viewport'
import type { Viewport } from '../src/shared/types'

describe('the viewport a width check shows', () => {
  test("a device's width is that device", () => {
    expect(viewportForWidth(390)).toBe('mobile')
    expect(viewportForWidth(820)).toBe('tablet')
    expect(viewportForWidth(1440)).toBe('laptop')
  })

  test('any other width is a frame that wide, as tall as the nearest device', () => {
    expect(viewportForWidth(768)).toBe('768x1180')
    expect(viewportForWidth(1024)).toBe('1024x1180')
    expect(viewportForWidth(375)).toBe('375x844')
    expect(viewportForWidth(320)).toBe('320x844')
    expect(viewportForWidth(1280)).toBe('1280x900')
    expect(viewportForWidth(1920)).toBe('1920x900')
  })
})

/** A tab showing `start`, with timers run by hand. */
function setup(start: Viewport = 'desktop') {
  let viewport = start
  const shown: { viewport: Viewport; morph: boolean }[] = []
  let settles = 0
  const timers = new Map<number, () => void>()
  let next = 0
  const agent = new AgentViewport(
    {
      current: () => viewport,
      show: (to, morph) => {
        viewport = to
        shown.push({ viewport: to, morph })
      },
      settle: async () => {
        settles++
      },
    },
    2500,
    {
      set: (fn) => {
        timers.set(++next, fn)
        return next
      },
      clear: (id) => timers.delete(id as number),
    },
  )
  return {
    agent,
    shown,
    settles: () => settles,
    current: () => viewport,
    /** The user (or anything else) changes the viewport */
    change: (to: Viewport) => {
      viewport = to
    },
    pending: () => timers.size,
    /** The hold lapses */
    lapse: () => {
      const fns = [...timers.values()]
      timers.clear()
      for (const fn of fns) fn()
    },
  }
}

describe("the agent's viewport", () => {
  test('a check resizes into its viewport, captures there, and goes back a moment after', async () => {
    const tab = setup('desktop')
    const during: Viewport[] = []
    await tab.agent.check('mobile', async () => {
      during.push(tab.current())
    })
    expect(during).toEqual(['mobile'])
    expect(tab.settles()).toBe(1)
    expect(tab.agent.shown).toBe('mobile')
    expect(tab.agent.user).toBe('desktop')
    // Held, not put back yet.
    expect(tab.shown).toEqual([{ viewport: 'mobile', morph: true }])
    expect(tab.pending()).toBe(1)
    tab.lapse()
    expect(tab.current()).toBe('desktop')
    expect(tab.shown.at(-1)).toEqual({ viewport: 'desktop', morph: true })
    expect(tab.agent.shown).toBeNull()
  })

  test('a run of checks goes from size to size and back once', async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => undefined)
    await tab.agent.check('768x1180', async () => undefined)
    await tab.agent.check('laptop', async () => undefined)
    expect(tab.pending()).toBe(1)
    tab.lapse()
    expect(tab.shown.map((step) => step.viewport)).toEqual([
      'mobile',
      '768x1180',
      'laptop',
      'desktop',
    ])
  })

  test('checks at once hold until the last one ends', async () => {
    const tab = setup('desktop')
    let finish = () => {}
    const first = tab.agent.check('mobile', () => new Promise<void>((done) => (finish = done)))
    await tab.agent.check('tablet', async () => undefined)
    // The first is still capturing: nothing to put back yet.
    expect(tab.pending()).toBe(0)
    finish()
    await first
    expect(tab.pending()).toBe(1)
    tab.lapse()
    expect(tab.current()).toBe('desktop')
  })

  test("the user's own viewport at that width needs no resize, and nothing comes back", async () => {
    const tab = setup('mobile')
    await tab.agent.check('mobile', async () => undefined)
    expect(tab.shown).toEqual([])
    expect(tab.settles()).toBe(0)
    expect(tab.pending()).toBe(0)
  })

  test("the user's pick between checks stays, and the next check comes back to it", async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => undefined)
    tab.change('laptop')
    tab.agent.userChose()
    expect(tab.pending()).toBe(0)
    tab.lapse()
    expect(tab.current()).toBe('laptop')
    await tab.agent.check('tablet', async () => undefined)
    expect(tab.agent.user).toBe('laptop')
    tab.lapse()
    expect(tab.current()).toBe('laptop')
  })

  test('picking the viewport the agent shows keeps it', async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => undefined)
    tab.agent.userChose()
    tab.lapse()
    expect(tab.current()).toBe('mobile')
  })

  test('the user picking mid-check wins over the hold', async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => {
      tab.change('tablet')
      tab.agent.userChose()
    })
    expect(tab.pending()).toBe(0)
    expect(tab.current()).toBe('tablet')
  })

  test('changed by anything else meanwhile, nothing is put back over it', async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => undefined)
    tab.change('1080x1080')
    tab.lapse()
    expect(tab.current()).toBe('1080x1080')
    // And the next check comes back to that one.
    await tab.agent.check('mobile', async () => undefined)
    expect(tab.agent.user).toBe('1080x1080')
  })

  test('the turn ending, or the tab going, puts it back at once', async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => undefined)
    tab.agent.restore(false)
    expect(tab.current()).toBe('desktop')
    expect(tab.shown.at(-1)).toEqual({ viewport: 'desktop', morph: false })
    expect(tab.pending()).toBe(0)
  })

  test('put back mid-check, the check ending holds nothing again', async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => {
      tab.agent.restore()
    })
    expect(tab.current()).toBe('desktop')
    expect(tab.pending()).toBe(0)
    expect(tab.agent.shown).toBeNull()
  })

  test('disposed, a pending hold is dropped', async () => {
    const tab = setup('desktop')
    await tab.agent.check('mobile', async () => undefined)
    tab.agent.dispose()
    expect(tab.pending()).toBe(0)
    expect(tab.agent.shown).toBeNull()
  })

  test("a failing check still holds, and the user's viewport still comes back", async () => {
    const tab = setup('desktop')
    await expect(
      tab.agent.check('mobile', async () => {
        throw new Error('no page')
      }),
    ).rejects.toThrow('no page')
    tab.lapse()
    expect(tab.current()).toBe('desktop')
  })
})
