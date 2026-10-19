import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { spawnProcess } from './process'

/**
 * Transcribes a narrated recording's audio on this Mac with Apple's SpeechAnalyzer
 * (macOS 26+), through the gui-transcribe helper (native/transcribe, scripts/build-native.sh).
 * Nothing leaves the machine; the system downloads a language's model the first time.
 */

export interface TranscriptWord {
  start: number
  end: number
  text: string
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  words: TranscriptWord[]
}

/** Times are ms from the clip's start, the frames' and the timeline's clock. */
export interface Transcript {
  engine: 'apple'
  locale: string
  segments: TranscriptSegment[]
}

const TIMEOUT_MS = 3 * 60_000
const MAX_OUTPUT = 4 * 1024 * 1024

const ms = z
  .number()
  .finite()
  .min(0)
  .max(24 * 60 * 60 * 1000)
const word = z.object({ start: ms, end: ms, text: z.string().max(200) })
const output = z.object({
  locale: z.string().max(40),
  segments: z
    .array(
      z.object({
        start: ms,
        end: ms,
        text: z.string().max(10_000),
        words: z.array(word).max(5000).default([]),
      }),
    )
    .max(5000),
})

export class TranscribeError extends Error {}

export function transcriberPath() {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'gui-transcribe')
    : join(app.getAppPath(), 'native', '.build', 'gui-transcribe')
}

/** Why this Mac can't transcribe at all, or null when it may. */
export function transcriptionUnavailable(): string | null {
  if (process.platform !== 'darwin') return 'Transcripts need macOS.'
  const major = Number(process.getSystemVersion().split('.')[0])
  if (Number.isFinite(major) && major < 26) return 'Transcripts need macOS 26 or later.'
  return null
}

const EXIT_MESSAGES: Record<number, string> = {
  3: 'Speech transcription is unavailable on this Mac.',
  4: "Speech transcription doesn't support your Mac's language yet.",
}

export async function transcribe(
  file: string,
  signal: AbortSignal,
  helper = transcriberPath(),
): Promise<Transcript> {
  const unavailable = transcriptionUnavailable()
  if (unavailable) throw new TranscribeError(unavailable)
  const { stdout, stderr, code } = await new Promise<{
    stdout: string
    stderr: string
    code: number | null
  }>((resolve, reject) => {
    const child = spawnProcess(helper, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT) child.kill('SIGKILL')
      else out.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.reduce((total, part) => total + part.length, 0) < 4096) err.push(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError') reject(new TranscribeError('Transcription was cancelled.'))
      else if (error.code === 'ENOENT')
        reject(new TranscribeError('The transcriber is missing from this copy of Gui.'))
      else reject(error)
    })
    child.on('close', (exitCode) =>
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').trim(),
        code: exitCode,
      }),
    )
  })
  if (signal.aborted) throw new TranscribeError('Transcription was cancelled.')
  if (code !== 0) {
    throw new TranscribeError(
      (code !== null && EXIT_MESSAGES[code]) ||
        (stderr
          ? `Couldn't transcribe: ${stderr.split('\n')[0].slice(0, 200)}`
          : "Couldn't transcribe the recording."),
    )
  }
  const parsed = output.safeParse(JSON.parse(stdout || 'null'))
  if (!parsed.success) throw new TranscribeError("Couldn't read the transcript.")
  return {
    engine: 'apple',
    locale: parsed.data.locale,
    segments: parsed.data.segments
      .map((segment) => ({ ...segment, text: segment.text.trim() }))
      .filter((segment) => segment.text)
      .sort((a, b) => a.start - b.start),
  }
}
