import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'

const DOWNLOAD_STALL_MS = 60_000

export interface DownloadProgress {
  received: number
  /** null when the server doesn't say */
  total: number | null
}

/**
 * Downloads `url` to `file` (readable only by the user), reporting progress, and returns
 * the file's `algorithm` digest in `encoding` for the caller to check against its pin.
 * Gives up when no bytes arrive for a minute. `what` names it in errors ("Node.js").
 */
export async function download(
  url: string,
  file: string,
  {
    what,
    algorithm,
    encoding,
    onProgress,
    signal,
  }: {
    what: string
    algorithm: 'sha256' | 'sha512'
    encoding: 'hex' | 'base64'
    onProgress: (progress: DownloadProgress) => void
    signal: AbortSignal
  },
): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`Couldn't download ${what} (${response.status}).`)
  }
  const length = Number(response.headers.get('content-length'))
  const total = Number.isFinite(length) && length > 0 ? length : null
  const hash = createHash(algorithm)
  let received = 0
  let stall: NodeJS.Timeout | undefined
  const stalled = new AbortController()
  const resetStall = () => {
    clearTimeout(stall)
    stall = setTimeout(() => stalled.abort(), DOWNLOAD_STALL_MS)
  }
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length
      resetStall()
      onProgress({ received, total })
      callback(null, chunk)
    },
  })
  resetStall()
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      meter,
      createWriteStream(file, { mode: 0o600 }),
      { signal: AbortSignal.any([signal, stalled.signal]) },
    )
  } catch (error) {
    if (stalled.signal.aborted && !signal.aborted) {
      throw new Error('The download stopped responding. Check your connection and try again.')
    }
    throw error
  } finally {
    clearTimeout(stall)
  }
  return hash.digest(encoding)
}
