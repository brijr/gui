import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

/** Inclusive byte offsets into a file. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * The part of a `size`-byte file a `Range` header asks for: a range, 'unsatisfiable' (416),
 * or null to send the whole file. Headers this doesn't understand (other units, several
 * ranges) get the whole file, as HTTP allows.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const parts = /^bytes=\s*(\d*)-(\d*)\s*$/.exec(header)
  if (!parts || (!parts[1] && !parts[2])) return null
  if (!parts[1]) {
    // The last N bytes
    const suffix = Number(parts[2])
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(parts[1])
  const end = parts[2] ? Math.min(Number(parts[2]), size - 1) : size - 1
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * Serves a file, or the byte range a request asks for (206), read from disk as it's sent:
 * a video player seeking a long clip reads only what it plays.
 */
export async function fileResponse(
  path: string,
  request: { method: string; headers: { get(name: string): string | null } },
  headers: Record<string, string>,
): Promise<Response> {
  const { size } = await stat(path)
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable')
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    })
  const { start, end } = range ?? { start: 0, end: size - 1 }
  const length = Math.max(0, end - start + 1)
  const sent: Record<string, string> = {
    ...headers,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  }
  const body =
    request.method === 'HEAD' || length === 0
      ? null
      : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>)
  return new Response(body, { status: range ? 206 : 200, headers: sent })
}
