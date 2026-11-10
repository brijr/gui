import type { Viewport } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent } from './helpers/tool-agent'

// The agent's width checks (preview_screenshot's `width`) resize the preview into that viewport
// the way the user's pick would, and the user's viewport comes back once, a moment after the
// last check or when the turn ends. Tools are called through a stand-in agent (tool-agent.ts),
// so this runs without an agent login or usage.

interface Recorded {
  /** Each viewport the preview showed, in order */
  viewports: Viewport[]
  /** The device each viewport morph's frame named */
  morphs: (Viewport | null)[]
}

/** Records, from the chrome, every viewport the preview shows and every viewport morph frame. */
async function record(session: GuiSession) {
  await session.chrome.evaluate(() => {
    const seen: { viewports: string[]; morphs: (string | null)[] } = { viewports: [], morphs: [] }
    ;(window as unknown as { agentViewport: typeof seen }).agentViewport = seen
    window.gui.onState((state) => {
      if (seen.viewports.at(-1) !== state.preview.viewport)
        seen.viewports.push(state.preview.viewport)
    })
    window.gui.onMorph((event) => {
      if (event.type === 'frame' && event.kind === 'viewport') seen.morphs.push(event.viewport)
    })
  })
}

/** What `record` saw, from the first change on (a state that changed nothing else repeats it). */
async function recorded(session: GuiSession, from: Viewport): Promise<Recorded> {
  const seen = await session.chrome.evaluate(
    () => (window as unknown as { agentViewport: Recorded }).agentViewport,
  )
  const first = seen.viewports.findIndex((viewport) => viewport !== from)
  return { ...seen, viewports: first === -1 ? [] : [from, ...seen.viewports.slice(first)] }
}

const viewport = async (session: GuiSession) => (await session.state()).preview.viewport

/** No morph moving the preview now. */
const resting = (session: GuiSession) =>
  session.app.evaluate(
    () => ((globalThis as { guiMorphing?: Set<number> }).guiMorphing?.size ?? 0) === 0,
  )

async function setup(session: GuiSession) {
  await session.waitForPreview()
  await installToolAgent(session)
  expect(await viewport(session)).toBe('desktop')
  await record(session)
}

test("a width check resizes into the device's viewport and back", async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await setup(session)

  // One check, then the agent thinks past the hold: Mobile shows, then Desktop comes back on
  // its own while the turn is still running.
  const [shot] = await ask(
    session,
    [{ name: 'preview_screenshot', args: { width: 390 } }, { wait: 5000 }],
    async () => {
      await waitFor(async () => (await viewport(session)) === 'mobile', 'the Mobile viewport')
      await expect(
        session.chrome.getByRole('button', { name: 'Viewport: Mobile', exact: true }),
      ).toBeVisible()
      await waitFor(
        async () => (await viewport(session)) === 'desktop',
        'Desktop again after the hold',
      )
      const { turns } = await session.chatSnapshot()
      expect(turns.at(-1)?.status).toBe('running')
    },
  )
  expect(shot.isError, JSON.stringify(shot)).not.toBe(true)
  expect(shot.content.find((item) => item.type === 'text')?.text).toMatch(
    /^viewport at viewport width 390px /,
  )
  const seen = await recorded(session, 'desktop')
  expect(seen.viewports).toEqual(['desktop', 'mobile', 'desktop'])
  // It resized there, as the user's pick does, rather than jumping.
  expect(seen.morphs).toContain('mobile')

  // A run of widths glides from size to size and comes back once, when the turn ends. 768 is
  // no device's: a frame of its own that wide, which the toolbar names.
  await record(session)
  const shots = await ask(
    session,
    [
      { name: 'preview_screenshot', args: { width: 390 } },
      { wait: 400 },
      { name: 'preview_screenshot', args: { width: 768 } },
      { wait: 400 },
      { name: 'preview_screenshot', args: { width: 1440 } },
    ],
    async () => {
      await waitFor(async () => (await viewport(session)) === '768x1180', 'the 768px frame')
      await expect(
        session.chrome.getByRole('button', { name: 'Viewport: 768 × 1180', exact: true }),
      ).toBeVisible()
    },
  )
  expect(shots.map((result) => result.content.find((item) => item.type === 'text')?.text)).toEqual([
    expect.stringMatching(/ width 390px /),
    expect.stringMatching(/ width 768px /),
    expect.stringMatching(/ width 1440px /),
  ])
  await waitFor(async () => (await viewport(session)) === 'desktop', 'Desktop after the turn')
  expect((await recorded(session, 'desktop')).viewports).toEqual([
    'desktop',
    'mobile',
    '768x1180',
    'laptop',
    'desktop',
  ])
})

test("the user's viewport pick during the agent's checks stays", async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await setup(session)

  await ask(
    session,
    [{ name: 'preview_screenshot', args: { width: 390 } }, { wait: 1500 }],
    async () => {
      await waitFor(
        async () => (await viewport(session)) === 'mobile' && (await resting(session)),
        'the Mobile viewport, at rest',
      )
      // The user picks Tablet while the agent's Mobile is held.
      await session.chrome.evaluate(() => window.gui.setViewport('tablet'))
    },
  )
  // Neither the hold nor the turn's end puts Desktop back over it.
  await waitFor(resting.bind(null, session), 'the preview at rest')
  expect(await viewport(session)).toBe('tablet')
  expect((await recorded(session, 'desktop')).viewports).toEqual(['desktop', 'mobile', 'tablet'])

  // The next check comes back to the user's Tablet, not Desktop.
  await record(session)
  await ask(session, [{ name: 'preview_screenshot', args: { width: 390 } }])
  await waitFor(async () => (await viewport(session)) === 'tablet', 'Tablet after the turn')
  expect((await recorded(session, 'tablet')).viewports).toEqual(['tablet', 'mobile', 'tablet'])
})
