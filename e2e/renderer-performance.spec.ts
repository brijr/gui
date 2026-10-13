import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ChatTurnUpdate } from '../src/shared/chat-transport'
import type { Turn } from '../src/shared/types'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

const ANSWER = [
  '## Result',
  '',
  'A structured answer with **emphasis**, `inline code`, and [a link](https://example.com).',
  '',
  '- Keep the preview responsive.',
  '- Preserve the current layout.',
  '- Check the finished result.',
  '',
].join('\n')

function turn(index: number, text = ANSWER.repeat(5)): Turn {
  return {
    id: `renderer-turn-${index}`,
    index,
    prompt: `Review request ${index}`,
    context: [],
    status: 'done',
    error: null,
    startedAt: Date.now() - 2000,
    endedAt: Date.now() - 1000,
    reverted: false,
    changes: [{ path: 'src/App.tsx', status: 'modified', additions: 2, deletions: 1 }],
    items: [
      {
        kind: 'tool',
        id: `renderer-tool-${index}`,
        title: 'Read src/App.tsx',
        toolKind: 'read',
        status: 'completed',
        locations: ['src/App.tsx'],
        startedAt: Date.now() - 2000,
        endedAt: Date.now() - 1000,
      },
      { kind: 'text', id: `renderer-text-${index}`, text },
    ],
  }
}

function seed(userData: string, root: string, count: number) {
  const name = createHash('sha1').update(realpathSync(root)).digest('hex').slice(0, 16)
  const chats = join(userData, 'chats')
  mkdirSync(chats, { recursive: true })
  writeFileSync(
    join(chats, `${name}.json`),
    JSON.stringify({
      version: 1,
      agentId: 'claude',
      sessionId: null,
      turns: Array.from({ length: count }, (_, index) => turn(index)),
      checkpoints: {},
      redo: null,
    }),
  )
}

interface RendererProbe {
  observer: PerformanceObserver
  timer: ReturnType<typeof setInterval>
  longTasks: number[]
  largestTimerGap: number
  mountedRows: number
  descendants: number
}

type ProbeWindow = Window & { __rendererProbe?: RendererProbe }

async function startProbe(page: Page) {
  await page.evaluate(() => {
    const state = window as ProbeWindow
    const started = performance.now()
    let last = started
    const probe: RendererProbe = {
      observer: new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= started) probe.longTasks.push(entry.duration)
        }
      }),
      timer: setInterval(() => {
        const now = performance.now()
        probe.largestTimerGap = Math.max(probe.largestTimerGap, now - last)
        last = now
        const transcript = document.querySelector('[data-transcript]')
        probe.mountedRows = Math.max(
          probe.mountedRows,
          transcript?.querySelectorAll('[data-turn-row]').length ?? 0,
        )
        probe.descendants = Math.max(
          probe.descendants,
          transcript?.querySelectorAll('*').length ?? 0,
        )
      }, 20),
      longTasks: [],
      largestTimerGap: 0,
      mountedRows: 0,
      descendants: 0,
    }
    probe.observer.observe({ type: 'longtask' })
    state.__rendererProbe = probe
  })
}

async function stopProbe(page: Page) {
  return page.evaluate(() => {
    const state = window as ProbeWindow
    const probe = state.__rendererProbe
    if (!probe) throw new Error('Renderer probe was not started')
    clearInterval(probe.timer)
    probe.observer.disconnect()
    delete state.__rendererProbe
    return {
      longTasks: probe.longTasks,
      longestTask: Math.max(0, ...probe.longTasks),
      largestTimerGap: probe.largestTimerGap,
      mountedRows: probe.mountedRows,
      descendants: probe.descendants,
    }
  })
}

async function publish(session: GuiSession, update: ChatTurnUpdate) {
  await session.app.evaluate(({ webContents }, message) => {
    const chat = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().endsWith('/chat.html'))
    if (!chat) throw new Error('Missing chat renderer')
    chat.send('chat:turn', message)
  }, update)
}

test('a 300-turn history mounts a bounded window and retains disclosure choices when revisited', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite', open: 'recent', reducedMotion: 'reduce' })
  seed(session.fixture.userData, session.fixture.root, 300)
  await startProbe(session.chat)
  await session.chrome.evaluate((root) => window.gui.openRecent(root), session.fixture.root)
  await session.waitForPreview()
  await session.chat.evaluate(() => window.gui.expandChat())
  await expect(session.chat.getByText('Review request 299', { exact: true })).toBeVisible()
  const initial = await stopProbe(session.chat)
  await testInfo.attach('history-renderer-metrics', {
    body: JSON.stringify(initial, null, 2),
    contentType: 'application/json',
  })
  expect(initial.mountedRows).toBeLessThan(30)
  expect(initial.descendants).toBeLessThan(2500)
  expect(initial.longestTask).toBeLessThan(200)

  const transcript = session.chat.locator('[data-transcript]')
  await transcript.evaluate((el) => {
    el.scrollTop = 0
  })
  const first = session.chat.locator('[data-turn-row="renderer-turn-0"]')
  await expect(first.getByText('Review request 0', { exact: true })).toBeVisible()
  const steps = first.getByRole('button', { name: /1 step/ })
  await steps.click()
  await expect(first.getByRole('list', { name: 'Steps' })).toBeVisible()
  await first.getByRole('button', { name: /1 file changed/ }).click()
  await expect(first.getByRole('list', { name: 'Changed files' })).toBeVisible()
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2
  })
  await expect(first).toHaveCount(0)
  await transcript.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(first.getByRole('list', { name: 'Steps' })).toBeVisible()
  await expect(first.getByRole('button', { name: /1 step/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(first.getByRole('list', { name: 'Changed files' })).toBeVisible()
  await testInfo.attach('transcript-desktop', {
    body: await session.chat.screenshot(),
    contentType: 'image/png',
  })
  // The minimum-width native chat exercises wrapping and result controls at mobile width.
  await session.chat.evaluate(() => {
    window.gui.resizeChat('left', 200, 0)
    window.gui.endResizeChat()
  })
  await expect.poll(() => transcript.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await testInfo.attach('transcript-narrow', {
    body: await session.chat.screenshot(),
    contentType: 'image/png',
  })
})

test('large revisioned Markdown updates stay responsive, retain permission/redo rows, and settle full GFM', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await session.waitForPreview()
  await session.chat.evaluate(() => window.gui.expandChat())
  const snapshot = await session.chatSnapshot()
  const live = turn(50, '[Late reference][late]\n\n')
  live.status = 'running'
  live.endedAt = null
  const textId = 'renderer-text-50'
  live.items.push({
    kind: 'permission',
    id: 'renderer-permission',
    title: 'Run npm test',
    toolKind: 'execute',
    locations: [],
    sensitive: false,
    resolved: null,
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: "Don't allow", kind: 'reject_once' },
    ],
  })
  const archived = Array.from({ length: 50 }, (_, index) => turn(index, 'Earlier answer.'))
  archived[49].reverted = true
  await session.app.evaluate(
    ({ webContents }, value) => {
      const chat = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().endsWith('/chat.html'))
      if (!chat) throw new Error('Missing chat renderer')
      chat.send('chat:reset', value)
    },
    {
      ...snapshot,
      meta: { ...snapshot.meta, status: 'working', redoTurnIds: [archived[49].id] },
      turns: [...archived, live],
      revisions: { [live.id]: 0 },
    },
  )
  const transcript = session.chat.locator('[data-transcript]')
  const current = session.chat.locator('[data-turn-row="renderer-turn-50"]')
  await expect(current.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
  await expect(session.chat.getByRole('button', { name: 'Redo', exact: true })).toBeVisible()
  await transcript.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(session.chat.getByText('Review request 0', { exact: true })).toBeVisible()
  // The permission remains mounted while the user reads archived messages; answering it
  // still has a DOM counterpart for the existing permission view transition.
  await expect(current.locator('[data-permission="renderer-permission"]')).toHaveCount(1)
  const readingTop = await session.chat
    .locator('[data-user-message="renderer-turn-0"]')
    .evaluate((el) => el.getBoundingClientRect().top)
  await startProbe(session.chat)
  const chunk = ANSWER.repeat(36)
  const streaming = session.app.evaluate(
    async ({ webContents }, { id, itemId, append }) => {
      const chat = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().endsWith('/chat.html'))
      if (!chat) throw new Error('Missing chat renderer')
      for (let revision = 1; revision <= 30; revision++) {
        chat.send('chat:turn', {
          kind: 'patch',
          id,
          baseRevision: revision - 1,
          revision,
          fields: {},
          items: [{ kind: 'append', id: itemId, text: append }],
        })
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    },
    { id: live.id, itemId: textId, append: chunk },
  )
  const inputStarted = Date.now()
  await session.chat.locator('[data-composer]').fill('The composer still works.')
  const inputElapsedMs = Date.now() - inputStarted
  await streaming
  await expect
    .poll(() =>
      session.chat
        .locator('[data-user-message="renderer-turn-0"]')
        .evaluate((el) => el.getBoundingClientRect().top),
    )
    .toBeCloseTo(readingTop, 0)
  const metrics = await stopProbe(session.chat)
  await testInfo.attach('streaming-renderer-metrics', {
    body: JSON.stringify({ characters: chunk.length * 30, inputElapsedMs, ...metrics }, null, 2),
    contentType: 'application/json',
  })
  expect(metrics.mountedRows).toBeLessThan(20)
  expect(metrics.longTasks.length).toBeLessThanOrEqual(4)
  expect(metrics.longestTask).toBeLessThan(200)
  expect(inputElapsedMs).toBeLessThan(1000)
  await expect(session.chat.locator('[data-composer]')).toHaveValue('The composer still works.')

  // An oversized unfinished fence switches to cheap text, then completion resolves late
  // references and the complete table/code syntax through the worker's whole-document parse.
  const fence = `\n\n\`\`\`txt\n${'large unfinished code '.repeat(1200)}`
  await publish(session, {
    kind: 'patch',
    id: live.id,
    baseRevision: 30,
    revision: 31,
    fields: {},
    items: [{ kind: 'append', id: textId, text: fence }],
  })
  await publish(session, {
    kind: 'patch',
    id: live.id,
    baseRevision: 31,
    revision: 32,
    fields: { status: 'done', endedAt: Date.now() },
    items: [
      {
        kind: 'append',
        id: textId,
        text: '\n```\n\n[late]: https://example.com/final\n\n| Feature | Value |\n| --- | --- |\n| Parsing | **done** |\n\n![remote](https://example.com/remote.png)',
      },
      {
        kind: 'replace',
        item: {
          ...live.items[live.items.length - 1],
          kind: 'permission',
          id: 'renderer-permission',
          title: 'Run npm test',
          toolKind: 'execute',
          locations: [],
          sensitive: false,
          options: [],
          resolved: 'allow',
        },
      },
    ],
  })
  // Scroll to the completed turn: its worker and disclosure state follow virtual remounts.
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(current.locator('[data-markdown-phase="complete"]')).toHaveCount(1)
  await expect(current.locator('[data-markdown-rendering]')).toHaveCount(0)
  await expect(current.getByRole('link', { name: 'Late reference' })).toHaveAttribute(
    'href',
    'https://example.com/final',
  )
  await expect(current.getByRole('table')).toHaveCount(1)
  await expect(current.locator('.markdown pre code')).toHaveCount(1)
  await expect(current.locator('.markdown img')).toHaveCount(0)
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2)
  await session.chat.evaluate(() => {
    window.gui.resizeChat('left', 200, 0)
    window.gui.endResizeChat()
  })
  await expect.poll(() => transcript.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2)
  await testInfo.attach('settled-markdown-narrow', {
    body: await session.chat.screenshot(),
    contentType: 'image/png',
  })
})

test('one large completed table renders between input frames with a single table container', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await session.waitForPreview()
  await session.chat.evaluate(() => window.gui.expandChat())
  const snapshot = await session.chatSnapshot()
  const text =
    '| Name | Value |\n| --- | --- |\n' +
    Array.from({ length: 2500 }, (_, index) => `| Entry ${index} | **${index}** |`).join('\n')
  const completed = turn(0, text)
  await startProbe(session.chat)
  await session.app.evaluate(
    ({ webContents }, value) => {
      const chat = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().endsWith('/chat.html'))
      if (!chat) throw new Error('Missing chat renderer')
      chat.send('chat:reset', value)
    },
    { ...snapshot, turns: [completed] },
  )
  const current = session.chat.locator('[data-turn-row="renderer-turn-0"]')
  await expect(current.locator('[data-markdown-phase="complete"]')).toHaveCount(1)
  await expect(current.locator('[data-markdown-rendering]')).toHaveCount(0)
  await expect(current.getByRole('table')).toHaveCount(1)
  await expect(current.locator('tbody tr')).toHaveCount(2500)
  const metrics = await stopProbe(session.chat)
  await testInfo.attach('single-table-renderer-metrics', {
    body: JSON.stringify({ characters: text.length, ...metrics }, null, 2),
    contentType: 'application/json',
  })
  expect(metrics.longTasks.length).toBeLessThanOrEqual(4)
  expect(metrics.longestTask).toBeLessThan(200)
})
