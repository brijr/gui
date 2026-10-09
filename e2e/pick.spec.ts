import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AgentId, CUSTOM_AGENT_PREFIX, isRegion } from '../src/shared/types'
import { electronExecutable, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Picking happens in Gui's overlay over the preview (main/picker.ts): a click picks an element,
// a drag an area, ⇧ adds to what's picked, the wheel scrolls the page underneath.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Picks`

/** A stand-in ACP agent that echoes the prompt's text and counts its images. No login, no usage. */
const AGENT_SCRIPT = String.raw`
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const handle = ({ id, method, params }) => {
  if (method === undefined || id === undefined) return
  if (method === 'initialize') {
    const agentCapabilities = { promptCapabilities: { image: true } }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') return write({ id, result: { sessionId: 'session-' + process.pid } })
  if (method === 'session/prompt') {
    const text = params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    const images = params.prompt.filter((block) => block.type === 'image').length
    const content = { type: 'text', text: 'IMAGES ' + images + '\n' + text }
    write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content } } })
    return write({ id, result: { stopReason: 'end_turn' } })
  }
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'picks-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Picks: { command: electronExecutable(), args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } },
  }
  writeFileSync(join(session.fixture.userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the stand-in agent to be listed')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === AGENT
  await waitFor(selected, 'the stand-in agent to be selected')
}

const selection = async (session: GuiSession) => (await session.chatSnapshot()).meta.selection
const selecting = async (session: GuiSession) => (await session.state()).preview.selecting

test('⇧-click picks several elements and picking goes on; a plain click starts over', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const overlay = await session.pickPage()

  // ⇧-click after ⇧-click: each joins the selection, numbered in the overlay, still picking.
  const heading = await session.pickElement('h1', { add: true })
  expect(heading.tag).toBe('h1')
  expect(await selecting(session)).toBe(true)
  const button = await session.pickElement('button.counter', { add: true })
  expect(button.tag).toBe('button')
  expect(await selecting(session)).toBe(true)
  expect((await selection(session)).map((picked) => picked.id)).toEqual([heading.id, button.id])
  await expect(overlay.locator('[data-outline="picked"]')).toHaveCount(2)
  await expect(overlay.locator('[data-outline="picked"]').nth(1)).toHaveText('2')
  await session.shot('picked-two')

  // ⇧-click on a picked element takes it back out.
  const box = await session.viewBox('h1')
  await session.overlayGesture(
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { add: true },
  )
  await waitFor(async () => (await selection(session)).length === 1, 'the heading taken out')
  expect((await selection(session))[0]?.id).toBe(button.id)
  await expect(overlay.locator('[data-outline="picked"]')).toHaveCount(1)

  // Esc ends picking and keeps what's picked; the composer lists it.
  await overlay.keyboard.press('Escape')
  await waitFor(async () => !(await selecting(session)), 'picking to end')
  expect((await selection(session)).map((picked) => picked.id)).toEqual([button.id])
  await expect(
    session.chat.getByRole('list', { name: 'Picked' }).getByRole('listitem'),
  ).toHaveCount(1)

  // A plain click replaces the selection and ends picking, as a single pick always has.
  await session.pickElement('h1', { add: true })
  expect(await selection(session)).toHaveLength(2)
  const only = await session.pickElement('button.counter')
  await waitFor(async () => !(await selecting(session)), 'the plain click to end picking')
  expect((await selection(session)).map((picked) => picked.id)).toEqual([only.id])

  // Removing it from the composer empties the selection.
  await session.chat.getByRole('button', { name: 'Remove selection' }).click()
  await waitFor(async () => (await selection(session)).length === 0, 'an empty selection')
})

test('dragging picks an area as a screenshot, and the agent gets every pick', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await useStandIn(session)
  await session.waitForPreview()

  // From just inside the heading's corner to just inside the button's: an area within <main>.
  const heading = await session.viewBox('h1')
  const button = await session.viewBox('button.counter')
  const from = { x: heading.x + 2, y: heading.y + 2 }
  const to = { x: button.x + button.width - 2, y: button.y + button.height - 2 }
  const area = await session.pickArea(from, to)
  expect(await selecting(session)).toBe(false)
  expect(area.screenshot).toMatch(/^data:image\/png;base64,/)
  // The gesture lands on whole pixels, so the area is within a pixel of the drag.
  expect(Math.abs(area.rect.width - (to.x - from.x))).toBeLessThanOrEqual(1)
  expect(Math.abs(area.rect.height - (to.y - from.y))).toBeLessThanOrEqual(1)
  expect(area.container?.tag).toBe('main')
  expect(area.container?.componentStack).toEqual(['App'])
  expect(area.container?.source?.file).toBe('src/App.tsx')
  await expect(session.chat.getByText('Area', { exact: true })).toBeVisible()
  await session.shot('picked-area')

  // A drag too small for an area is a click: it picks the element.
  const inButton = { x: button.x + button.width / 2, y: button.y + button.height / 2 }
  const clicked = await session.pickAt(inButton, {
    to: { x: inButton.x + 3, y: inButton.y + 2 },
    add: true,
  })
  expect(isRegion(clicked)).toBe(false)
  expect(await selection(session)).toHaveLength(2)
  await (await session.pickPage()).keyboard.press('Escape')
  await waitFor(async () => !(await selecting(session)), 'picking to end')

  // Both go to the agent, in order, each with its image; the turn keeps both.
  const index = (await session.chatSnapshot()).turns.length
  expect(await session.chat.evaluate(() => window.gui.send('Make these match'))).toBe(true)
  const { turn, meta } = await session.waitForTurn(index)
  expect(turn.status, turn.error ?? '').toBe('done')
  const answer = turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
  expect(answer).toMatch(/^IMAGES 2\n/)
  expect(answer).toContain('The user selected 2 things in the preview, in this order:')
  expect(answer).toMatch(/<selected_area_[0-9a-f]+>\nSelection 1 of 2\n/)
  expect(answer).toContain('Inside: <main>, the smallest element around all of the area')
  expect(answer).toMatch(/<selected_element_[0-9a-f]+>\nSelection 2 of 2\n/)
  expect(turn.context.map((picked) => picked.kind ?? 'element')).toEqual(['region', 'element'])
  expect(meta.selection).toEqual([])
  await expect(session.chat.getByRole('list', { name: 'Picked' })).toHaveCount(1)
})

test('the wheel scrolls the page while picking, and outlines follow it', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const preview = await session.previewPage()
  await preview.evaluate(() => {
    const spacer = document.createElement('div')
    spacer.style.height = '3000px'
    document.body.append(spacer)
  })
  const overlay = await session.pickPage()

  // Hovering outlines the element under the pointer and names it: its component, its size.
  const button = await session.viewBox('button.counter')
  const inButton = { x: button.x + button.width / 2, y: button.y + button.height / 2 }
  await session.startPicking()
  await session.overlayPointer(inButton)
  await expect(overlay.locator('[data-outline="hover"]')).toHaveCount(1)
  await expect(overlay.locator('[data-label]')).toContainText('App')
  await expect(overlay.locator('[data-label]')).toContainText(
    `${Math.round(button.width)} × ${Math.round(button.height)}`,
  )
  await session.shot('hover')

  await session.pickElement('button.counter', { add: true })
  const outline = overlay.locator('[data-outline="picked"]')
  const top = async () => (await outline.boundingBox())?.y ?? Number.NaN
  const before = await top()
  expect(before).toBeCloseTo(button.y, 0)

  // The wheel over the overlay scrolls the page under it; the outline moves with the button.
  await session.overlayPointer(inButton, 200)
  await waitFor(() => preview.evaluate(() => scrollY > 0), 'the page to scroll')
  const scrolled = await preview.evaluate(() => scrollY)
  await waitFor(
    async () => Math.abs((await top()) - (before - scrolled)) <= 1,
    'the outline to follow the scroll',
  )
  expect(await selecting(session)).toBe(true)
})

test('picks below the first screen once the page is scrolled', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const preview = await session.previewPage()
  await preview.evaluate(() => {
    const spacer = document.createElement('div')
    spacer.style.height = '2000px'
    const below = document.createElement('p')
    below.id = 'below'
    below.textContent = 'Below the fold'
    const after = document.createElement('div')
    after.style.height = '2000px'
    document.body.append(spacer, below, after)
    below.scrollIntoView({ block: 'center' })
  })
  await waitFor(() => preview.evaluate(() => scrollY > 1000), 'the page to scroll')
  const overlay = await session.pickPage()

  // The protocol hit-tests in page coordinates; the overlay's are the viewport's.
  const box = await session.viewBox('#below')
  await session.startPicking()
  await session.overlayPointer({ x: box.x + 10, y: box.y + box.height / 2 })
  await expect(overlay.locator('[data-label]')).toContainText(
    `${Math.round(box.width)} × ${Math.round(box.height)}`,
  )
  const picked = await session.pickElement('#below')
  expect(picked.tag).toBe('p')
  expect(picked.attributes.id).toBe('below')
})
