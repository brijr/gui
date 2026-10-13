import { expect, test } from 'bun:test'
import { retireProject, waitForRetiredProject } from '../src/main/project-handoff'

test('reopening waits for every retiring owner of the same root', async () => {
  let firstDone!: () => void
  let secondDone!: () => void
  const first = new Promise<void>((resolve) => {
    firstDone = resolve
  })
  const second = new Promise<void>((resolve) => {
    secondDone = resolve
  })
  retireProject('/tmp/gui-handoff/same', first)
  retireProject('/tmp/gui-handoff/same/../same', second)
  let reopened = false
  const waiting = waitForRetiredProject('/tmp/gui-handoff/same').then(() => {
    reopened = true
  })
  firstDone()
  await Promise.resolve()
  expect(reopened).toBe(false)
  secondDone()
  await waiting
  expect(reopened).toBe(true)
})

test('an unrelated root can open while retirement continues, and failed retirement does not deadlock', async () => {
  let release!: () => void
  let ended = false
  const pending = retireProject(
    '/tmp/gui-handoff/pending',
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  void pending.then(() => {
    ended = true
  })
  await waitForRetiredProject('/tmp/gui-handoff/unrelated')
  expect(ended).toBe(false)
  release()
  await pending
  expect(ended).toBe(true)
  const failure = retireProject('/tmp/gui-handoff/failed', Promise.reject(new Error('save failed')))
  await failure
  await waitForRetiredProject('/tmp/gui-handoff/failed')
  expect(await waitForRetiredProject('/tmp/gui-handoff/failed')).toBeUndefined()
})
