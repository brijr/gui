import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from '../src/main/process'

const userData = await mkdtemp(join(tmpdir(), 'gui-recordings-'))
afterAll(() => rm(userData, { recursive: true, force: true }))

// The transcriber is a stand-in that runs until it's stopped, like one on a long clip.
const appPath = join(userData, 'app')
await mkdir(join(appPath, 'native', '.build'), { recursive: true })
await writeFile(join(appPath, 'native', '.build', 'gui-transcribe'), '#!/bin/sh\nexec sleep 30\n')
await chmod(join(appPath, 'native', '.build', 'gui-transcribe'), 0o755)
mock.module('electron', () => ({
  app: { getPath: () => userData, isPackaged: false, getAppPath: () => appPath },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) },
}))
// Electron's
const system = process as typeof process & { getSystemVersion?: () => string }
system.getSystemVersion ??= () =>
  process.platform === 'darwin'
    ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    : '0'
const { Recordings, recordingProjectKey } = await import('../src/main/recordings')
const { transcriptionUnavailable } = await import('../src/main/transcribe')

const hex = (text: string) =>
  Uint8Array.from(text.replace(/\s/g, '').match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
/** A frame header the recorder's JPEGs start with: 640 × 360 */
const FRAME = hex('ffd8 ffc0 0011 08 0168 0280 03 000000000000000000 ffd9')
/**
 * A recorder's first chunk: EBML header, a live segment (size unknown), Info with
 * TimecodeScale 1 ms, then a cluster.
 */
const FIRST = hex(`
  1a45dfa3 84 4282 8177
  18538067 01ffffffffffffff
  1549a966 87 2ad7b1 83 0f4240
  1f43b675 01ffffffffffffff`)
const MORE = hex('a3 81 00')
const WAV = new Uint8Array(64)
WAV.set([0x52, 0x49, 0x46, 0x46], 0)
WAV.set([0x57, 0x41, 0x56, 0x45], 8)

const root = '/projects/example'
const dirOf = (id: string) => join(userData, 'recordings', recordingProjectKey(root), id)

async function narratedClip(recordings: InstanceType<typeof Recordings>) {
  const id = await recordings.start(true)
  expect(await recordings.frame(id, 0, FRAME)).toBe(true)
  expect(await recordings.video(id, FIRST)).toBe(true)
  expect(await recordings.video(id, MORE)).toBe(true)
  const clip = await recordings.finish(id, 1500, { audio: WAV })
  return { id, clip }
}

describe('Recordings', () => {
  test('saves the video as it comes, with its duration written in at the end', async () => {
    const recordings = new Recordings(root)
    const { id, clip } = await narratedClip(recordings)
    expect(clip.width).toBe(640)
    expect(clip.height).toBe(360)
    expect(clip.narration?.status).toBe('transcribing')
    const video = await readFile(join(dirOf(id), 'video.webm'))
    expect(video.length).toBe(FIRST.length + 11 + MORE.length)
    const at = video.indexOf(Buffer.from([0x44, 0x89, 0x88])) + 3
    expect(video.readDoubleBE(at)).toBe(1500)
    expect([...video.subarray(video.length - MORE.length)]).toEqual([...MORE])
    recordings.retain([id])
    recordings.dispose()
  })

  // Transcription runs only on macOS 26 and later.
  test.skipIf(transcriptionUnavailable() !== null)(
    'a clip kept as its project closes ends "stopped", not "Transcribing…"',
    async () => {
      const updates: string[] = []
      const recordings = new Recordings(root, (clip) => updates.push(clip.narration?.status ?? ''))
      const { id } = await narratedClip(recordings)
      // Sent with a message, then the project closes mid-transcription.
      recordings.retain([id])
      recordings.dispose()
      const [clip] = await recordings.settled([id], 5000)
      expect(clip.narration).toEqual({
        status: 'failed',
        error: 'Transcription stopped because the project closed.',
      })
      expect(updates).toEqual(['failed'])
      expect(existsSync(join(dirOf(id), 'audio.wav'))).toBe(false)
    },
  )

  test('an unsent clip goes with its project, and nothing is written back', async () => {
    const updates: string[] = []
    const recordings = new Recordings(root, (clip) => updates.push(clip.narration?.status ?? ''))
    const { id } = await narratedClip(recordings)
    recordings.dispose()
    // Removed in the background as the project closes
    for (let tries = 0; tries < 100 && existsSync(dirOf(id)); tries++) await Bun.sleep(20)
    expect(existsSync(dirOf(id))).toBe(false)
    await Bun.sleep(100)
    expect(updates).toEqual([])
  })

  test('refuses video past its size limit, and anything that is not WebM', async () => {
    const recordings = new Recordings(root)
    const id = await recordings.start(false)
    await expect(recordings.video(id, new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      'Invalid recording video.',
    )
    await expect(recordings.video(id, new Uint8Array(64 * 1024 * 1024 + 1))).rejects.toThrow(
      'size limit',
    )
    await recordings.discard(id)
    expect(existsSync(dirOf(id))).toBe(false)
    recordings.dispose()
  })
})
