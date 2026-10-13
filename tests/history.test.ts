import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SavedChat } from '../src/main/history'
import { serializeHistory } from '../src/main/history-format'
import { readHistory, readLastMessage } from '../src/main/history-reader'
import { historyStamp, type LiveSummary, summaryFile } from '../src/main/history-summary'
import { HistoryWriter } from '../src/main/history-writer'

let userData = ''
mock.module('electron', () => ({ app: { getPath: () => userData } }))
const {
  archiveChat,
  archiveStoredChat,
  chatReferences,
  claimHistoryFile,
  claimedHistoryFiles,
  historyFile,
  lastMessage,
  listArchived,
  loadArchived,
  loadHistory,
  releaseHistoryFile,
  removeArchived,
  renameArchived,
  retireHistoryFile,
} = await import('../src/main/history')

const cleanups: string[] = []
afterEach(async () => {
  for (const file of claimedHistoryFiles()) releaseHistoryFile(file)
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function project() {
  userData = await mkdtemp(join(tmpdir(), 'gui-history-test-'))
  cleanups.push(userData)
  const root = join(userData, 'project')
  await mkdir(root)
  return { root, file: await historyFile(root) }
}

function chat(
  prompt = 'Make the header sticky',
  id = '01234567-0123-0123-0123-0123456789ab',
): SavedChat {
  return {
    version: 1,
    id,
    createdAt: 1,
    agentId: 'claude',
    sessionId: null,
    checkpoints: {},
    redo: null,
    turns: [
      {
        id: 'turn-1',
        index: 0,
        prompt,
        context: [],
        items: [],
        status: 'done',
        error: null,
        reverted: false,
        startedAt: 1,
        endedAt: 2,
        changes: null,
      },
    ],
  }
}

test('a current durable summary reads only bounded data, and legacy summaries migrate once', async () => {
  const { file } = await project()
  await mkdir(dirname(file), { recursive: true })
  const state = chat('  Update   the header  ')
  state.turns[0].items = [{ id: 'large', kind: 'text', text: 'Response '.repeat(500_000) }]
  await writeFile(file, serializeHistory(state))
  expect(await readLastMessage(file)).toEqual({ prompt: 'Update the header', at: 1 })
  const summary = JSON.parse(await readFile(summaryFile(file), 'utf8')) as LiveSummary
  expect(summary.source).toEqual(historyStamp(await stat(file)))
  expect((await stat(summaryFile(file))).size).toBeLessThan(4096)
  const parse = spyOn(JSON, 'parse')
  try {
    expect(await readLastMessage(file)).toEqual({ prompt: 'Update the header', at: 1 })
    expect(parse.mock.calls.every(([text]) => typeof text === 'string' && text.length < 4096)).toBe(
      true,
    )
  } finally {
    parse.mockRestore()
  }
  // If metadata still matches, even a file that is no longer readable as JSON needs no parse.
  await writeFile(file, 'an intentionally non-JSON transcript')
  await writeFile(
    summaryFile(file),
    JSON.stringify({ ...summary, source: historyStamp(await stat(file)) }),
  )
  expect(await readLastMessage(file)).toEqual({ prompt: 'Update the header', at: 1 })
})

test('stale, malformed and oversized summaries rebuild safely; empty/image-only chats stay small', async () => {
  const { root, file } = await project()
  await new HistoryWriter(file, () => chat('Older')).close()
  await writeFile(file, serializeHistory(chat('Newer')))
  expect(await lastMessage(root)).toEqual({ prompt: 'Newer', at: 1 })
  await writeFile(summaryFile(file), '{invalid')
  expect(await lastMessage(root)).toEqual({ prompt: 'Newer', at: 1 })
  await writeFile(summaryFile(file), 'x'.repeat(100_000))
  expect(await lastMessage(root)).toEqual({ prompt: 'Newer', at: 1 })
  const images = chat(' ')
  images.turns[0].startedAt = 3
  await new HistoryWriter(file, () => images).close()
  expect(await lastMessage(root)).toEqual({ prompt: 'Image', at: 3 })
  const long = chat('User prompt '.repeat(100_000))
  await new HistoryWriter(file, () => long).close()
  expect((await lastMessage(root))?.prompt.length).toBeLessThanOrEqual(200)
  await new HistoryWriter(file, () => ({ ...images, turns: [] })).close()
  expect(await lastMessage(root)).toBeNull()
})

test('worker loads settle interrupted turns and permissions, preserving large strings and special keys', async () => {
  const { file } = await project()
  const state = chat()
  const text = 'Unicode 😀 and controls \n\t\\"'.repeat(20_000)
  state.checkpoints = JSON.parse(
    '{"turn-1":{"before":"aabbccdd","after":null},"__proto__":{"before":"1234","after":null}}',
  )
  state.turns[0].status = 'running'
  state.turns[0].items = [
    { id: 'response', kind: 'text', text },
    {
      id: 'permission',
      kind: 'permission',
      title: 'Edit file',
      toolKind: 'edit',
      locations: [],
      sensitive: false,
      options: [],
      resolved: null,
    },
  ]
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, serializeHistory(state))
  const result = await loadHistory(file)
  expect(result?.turns[0]).toMatchObject({
    status: 'cancelled',
    endedAt: 1,
    changesUnknown: true,
  })
  expect(result?.turns[0].items[0]).toEqual({ id: 'response', kind: 'text', text })
  expect(result?.turns[0].items[1]).toMatchObject({ resolved: 'cancelled' })
  expect(Object.hasOwn(result?.checkpoints ?? {}, '__proto__')).toBe(true)
  expect(Object.getOwnPropertyDescriptor(result?.checkpoints ?? {}, '__proto__')?.value).toEqual({
    before: '1234',
    after: null,
  })
  // Summaries/references never deliver the full chat, even for this large response.
  const summary = await readHistory({ action: 'summary', file })
  expect(JSON.stringify(summary).length).toBeLessThan(1024)
  const references = await readHistory({ action: 'references', file })
  expect(JSON.stringify(references).length).toBeLessThan(1024)
})

test('archive, rename, index rebuild, reopen, removal and numbered retirement preserve summaries and claims', async () => {
  const { root, file } = await project()
  const state = chat()
  await new HistoryWriter(file, () => state).close()
  expect(await archiveStoredChat(root)).toBe(true)
  expect(await lastMessage(root)).toBeNull()
  expect(await stat(summaryFile(file)).catch(() => null)).toBeNull()
  const archive = file.replace(/\.json$/, '')
  expect(await readdir(archive)).toHaveLength(2) // One transcript and its small list index.
  await renameArchived(root, state.id, '  Header   work ')
  expect((await listArchived(root))[0]).toMatchObject({
    title: 'Header work',
    prompt: state.turns[0].prompt,
  })
  await rm(join(archive, 'index.json'))
  expect((await listArchived(root))[0]).toMatchObject({ title: 'Header work', turns: 1 })
  const reopened = await loadArchived(root, state.id)
  expect(reopened).not.toBeNull()
  await new HistoryWriter(file, () => reopened as SavedChat).close()
  await removeArchived(root, state.id)
  expect(await listArchived(root)).toEqual([])
  expect(await lastMessage(root)).toEqual({ prompt: state.turns[0].prompt, at: 1 })
  expect(await claimHistoryFile(root)).toBe(file)
  expect(await archiveStoredChat(root)).toBe(false)
  const numbered = await claimHistoryFile(root)
  expect(numbered).toContain('-2.json')
  const other = chat('Another tab', '11234567-0123-0123-0123-0123456789ab')
  await new HistoryWriter(numbered, () => other).close()
  await retireHistoryFile(root, numbered)
  expect(claimedHistoryFiles()).toEqual([file])
  expect(await stat(summaryFile(numbered)).catch(() => null)).toBeNull()
  expect((await listArchived(root))[0]?.prompt).toBe('Another tab')
})

test('unreadable histories and recovery files retain references conservatively', async () => {
  const { root, file } = await project()
  const state = chat()
  state.checkpoints = { 'turn-1': { before: 'before', after: 'after' } }
  state.redo = { sha: 'redo', paths: [], turnIds: [] }
  state.versions = [
    { id: state.id, kind: 'named', name: 'Saved', sha: 'aabbccdd', createdAt: 1, changes: null },
  ]
  const recording = {
    id: state.id,
    name: 'Preview recording',
    url: `gui-recording://${'a'.repeat(32)}/${state.id}/video.webm`,
    thumbnail: 'data:image/png;base64,AAAA',
    durationMs: 1000,
    width: 100,
    height: 100,
    frameCount: 30,
  }
  state.turns[0].recordings = [recording]
  const queuedId = '11234567-0123-0123-0123-0123456789ab'
  state.queue = [
    {
      message: {
        id: queuedId,
        prompt: 'Queued clip',
        context: [],
        attachments: [],
        recordings: [{ ...recording, id: queuedId }],
      },
      images: [],
      selection: [],
      viewport: null,
    },
  ]
  await new HistoryWriter(file, () => state).close()
  expect([...((await chatReferences(root))?.checkpoints ?? [])].sort()).toEqual([
    'aabbccdd',
    'after',
    'before',
    'redo',
  ])
  expect([...((await chatReferences(root))?.recordings ?? [])].sort()).toEqual([state.id, queuedId])
  await writeFile(file, '{broken')
  expect(await lastMessage(root)).toBeNull()
  expect(await chatReferences(root)).toBeNull()
  expect(await loadHistory(file)).toBeNull()
  expect(await readdir(dirname(file))).toHaveLength(1) // Preserved recovery file, no stale summary.
  expect(await chatReferences(root)).toBeNull()
  // A non-file transcript is also unreadable, rather than an empty set of references.
  await mkdir(file)
  expect(await chatReferences(root)).toBeNull()
})

test('missing and malformed archive indexes rebuild many files without unbounded read fan-out', async () => {
  const { root, file } = await project()
  const folder = file.replace(/\.json$/, '')
  await mkdir(folder, { recursive: true })
  const names: string[] = []
  for (let index = 0; index < 40; index++) {
    const id = `${index.toString(16).padStart(8, '0')}-0123-0123-0123-0123456789ab`
    const state = chat(`Archived ${index}`)
    state.turns[0].items = [{ id: 'response', kind: 'text', text: 'Response '.repeat(10_000) }]
    state.turns[0].endedAt = index + 2
    names.push(`${id}.json`)
    // The filename remains authoritative for older or manually edited chat IDs.
    await writeFile(join(folder, `${id}.json`), serializeHistory(state))
  }
  const list = await listArchived(root)
  expect(list).toHaveLength(40)
  expect(new Set(list.map((entry) => entry.id)).size).toBe(40)
  expect(list[0]?.prompt).toBe('Archived 39')
  await writeFile(join(folder, 'index.json'), '{broken index')
  expect(await listArchived(root)).toEqual(list)
  expect((await readdir(folder)).sort()).toEqual([...names, 'index.json'].sort())
})

test('overlapping archive writes keep the final acknowledged snapshot in both file and index', async () => {
  const { root } = await project()
  const older = chat('Old prompt')
  older.turns[0].items = [{ id: 'slow', kind: 'text', text: 'Large '.repeat(200_000) }]
  const newer = chat('New prompt')
  await Promise.all([archiveChat(root, older), archiveChat(root, newer)])
  expect((await listArchived(root))[0]?.prompt).toBe('New prompt')
  expect((await loadArchived(root, newer.id))?.turns[0].prompt).toBe('New prompt')
})
