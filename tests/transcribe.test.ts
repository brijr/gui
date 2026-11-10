import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from '../src/main/process'

const root = resolve(import.meta.dirname, '..')
mock.module('electron', () => ({ app: { isPackaged: false, getAppPath: () => root } }))
// Electron's; the helper itself reports an older macOS too.
const system = process as typeof process & { getSystemVersion?: () => string }
system.getSystemVersion ??= () =>
  process.platform === 'darwin'
    ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    : '0'
const { transcribe, transcriberPath, transcriptionUnavailable } = await import(
  '../src/main/transcribe'
)

const dir = await mkdtemp(join(tmpdir(), 'gui-transcribe-'))
afterAll(() => rm(dir, { recursive: true, force: true }))

async function helper(name: string, script: string) {
  const file = join(dir, name)
  await writeFile(file, `#!/bin/sh\n${script}\n`)
  await chmod(file, 0o755)
  return file
}

const available = transcriptionUnavailable() === null

describe.skipIf(!available)('transcribe', () => {
  test("reads the helper's segments, in order and trimmed", async () => {
    const fake = await helper(
      'ok',
      `echo '{"locale":"en-US","segments":[{"start":900,"end":1500,"text":" second ","words":[]},{"start":0,"end":800,"text":"first","words":[{"start":0,"end":400,"text":"first"}]},{"start":1600,"end":1700,"text":"  "}]}'`,
    )
    const result = await transcribe('in.wav', new AbortController().signal, fake)
    expect(result).toEqual({
      engine: 'apple',
      locale: 'en-US',
      segments: [
        { start: 0, end: 800, text: 'first', words: [{ start: 0, end: 400, text: 'first' }] },
        { start: 900, end: 1500, text: 'second', words: [] },
      ],
    })
  })

  test('says why when this Mac or language cannot transcribe', async () => {
    const unavailable = await helper('unavailable', 'echo "nope" >&2; exit 3')
    await expect(transcribe('in.wav', new AbortController().signal, unavailable)).rejects.toThrow(
      'Speech transcription is unavailable on this Mac.',
    )
    const failed = await helper('failed', 'echo "The file is not audio." >&2; exit 1')
    await expect(transcribe('in.wav', new AbortController().signal, failed)).rejects.toThrow(
      "Couldn't transcribe: The file is not audio.",
    )
    const garbled = await helper('garbled', `echo '{"segments":"no"}'`)
    await expect(transcribe('in.wav', new AbortController().signal, garbled)).rejects.toThrow(
      "Couldn't read the transcript.",
    )
    await expect(
      transcribe('in.wav', new AbortController().signal, join(dir, 'missing')),
    ).rejects.toThrow('The transcriber is missing from this copy of Gui.')
  })

  test('stops when asked', async () => {
    const slow = await helper('slow', 'sleep 5')
    const abort = new AbortController()
    const running = transcribe('in.wav', abort.signal, slow)
    abort.abort()
    await expect(running).rejects.toThrow('Transcription stopped.')
  })

  // The real helper on real speech, where it's been built (scripts/build-native.sh).
  test.skipIf(!existsSync(transcriberPath()))(
    'transcribes speech with word times',
    async () => {
      const aiff = join(dir, 'speech.aiff')
      const wav = join(dir, 'speech.wav')
      execFileSync('say', ['-o', aiff, 'Make this button bigger.'])
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
      const result = await transcribe(wav, new AbortController().signal)
      const said = result.segments.map((segment) => segment.text).join(' ')
      expect(said.toLowerCase()).toContain('button')
      const words = result.segments.flatMap((segment) => segment.words)
      expect(words.length).toBeGreaterThan(2)
      for (const word of words) expect(word.end).toBeGreaterThanOrEqual(word.start)
    },
    30_000,
  )
})
