import { expect, test } from 'bun:test'
import { SleepPrevention } from '../src/main/sleep-prevention'

function setup() {
  let held = 0
  let acquisitions = 0
  const sleep = new SleepPrevention(() => {
    held++
    acquisitions++
    return () => held--
  })
  return { sleep, held: () => held, acquisitions: () => acquisitions }
}

test('only the last finishing agent releases sleep prevention', () => {
  const { sleep, held } = setup()
  const first = {}
  const second = {}
  sleep.setMode('working')
  expect(held()).toBe(0)
  sleep.setWorking(first, true)
  sleep.setWorking(second, true)
  expect(held()).toBe(1)
  sleep.setWorking(first, false)
  expect(held()).toBe(1)
  sleep.setWorking(second, false)
  expect(held()).toBe(0)
})

test('mode changes apply immediately to work already under way', () => {
  const { sleep, held, acquisitions } = setup()
  const chat = {}
  sleep.setWorking(chat, true)
  expect(held()).toBe(0)
  sleep.setMode('working')
  expect(held()).toBe(1)
  sleep.setMode('always')
  sleep.setWorking(chat, false)
  expect(held()).toBe(1)
  expect(acquisitions()).toBe(1)
  sleep.setMode('working')
  expect(held()).toBe(0)
  sleep.setWorking(chat, true)
  sleep.setMode('off')
  expect(held()).toBe(0)
})

test('quitting releases even an always-on hold and rejects late updates', () => {
  const { sleep, held } = setup()
  sleep.setMode('always')
  expect(held()).toBe(1)
  sleep.dispose()
  sleep.setMode('always')
  sleep.setWorking({}, true)
  expect(held()).toBe(0)
})
