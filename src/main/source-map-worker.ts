import { parentPort } from 'node:worker_threads'
import { type RawSourceMap, SourceMapConsumer } from 'source-map-js'
import type { MappedPosition, MapRequest } from './source-map-protocol'

interface IndexSourceMap {
  version: number | string
  sections: unknown[]
}
type SourceMapInput = RawSourceMap | IndexSourceMap
interface LoadedMap {
  consumer: SourceMapConsumer
  baseUrl: string
  /** Conservative charge for JSON plus decoded consumer structures, not exact heap usage. */
  bytes: number
}
const FETCH_TIMEOUT_MS = 3000
const MAX_FETCH_BYTES = 32 * 1024 * 1024
const CACHE_TTL_MS = 5000
const CACHE_MAX = 20
const CACHE_BYTES = 64 * 1024 * 1024
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const SOURCE_MAPPING_URL = /\/[/*][#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g
const MapConsumer = SourceMapConsumer as unknown as new (map: SourceMapInput) => SourceMapConsumer
const mapCache = new Map<string, { expires: number; value: LoadedMap | null }>()

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// --- source maps ---

function isLocalHttp(url: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname)
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url)
    if (!isLocalHttp(parsed)) return null
    // redirect: 'error' so a local server can't bounce us to another host
    const res = await fetch(parsed, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!res.ok || !res.body) {
      await res.body?.cancel()
      return null
    }
    return await readCapped(res.body)
  } catch {
    return null
  }
}

/** Reads a response body as text, giving up past MAX_FETCH_BYTES. */
async function readCapped(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_FETCH_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function resolveUrl(ref: string, base: string): string {
  try {
    return new URL(ref, base).href
  } catch {
    return ref
  }
}

function lastSourceMappingUrl(code: string): string | null {
  let last: string | null = null
  for (const match of code.matchAll(SOURCE_MAPPING_URL)) last = match[1] ?? last
  return last
}

function decodeDataUrl(url: string): string | null {
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const meta = url.slice('data:'.length, comma)
  const payload = url.slice(comma + 1)
  if (/;base64$/i.test(meta)) return Buffer.from(payload, 'base64').toString('utf8')
  return safeDecode(payload)
}

function isSourceMapInput(value: unknown): value is SourceMapInput {
  if (typeof value !== 'object' || value === null) return false
  if ('sections' in value) return Array.isArray(value.sections)
  return (
    'mappings' in value &&
    typeof value.mappings === 'string' &&
    'sources' in value &&
    Array.isArray(value.sources)
  )
}

async function fetchMap(scriptUrl: string): Promise<LoadedMap | null> {
  const code = await fetchText(scriptUrl)
  const ref = code === null ? null : lastSourceMappingUrl(code)
  if (!ref) return null

  let text: string | null
  let baseUrl = scriptUrl
  if (ref.startsWith('data:')) {
    text = decodeDataUrl(ref)
  } else {
    baseUrl = new URL(ref, scriptUrl).href
    // Maps must come from the same server as the script that referenced them.
    if (new URL(baseUrl).origin !== new URL(scriptUrl).origin) return null
    text = await fetchText(baseUrl)
  }
  if (text === null || Buffer.byteLength(text) > MAX_FETCH_BYTES) return null

  const raw: unknown = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, '')) // strip XSSI prefix
  if (!isSourceMapInput(raw)) return null
  return { consumer: new MapConsumer(raw), baseUrl, bytes: Buffer.byteLength(text) * 4 }
}

async function loadMap(scriptUrl: string): Promise<LoadedMap | null> {
  const now = Date.now()
  for (const [key, entry] of mapCache) if (entry.expires <= now) mapCache.delete(key)
  const hit = mapCache.get(scriptUrl)
  if (hit) return hit.value
  const value = await fetchMap(scriptUrl).catch(() => null)
  // An oversized map may be used once, but is never retained by the cache.
  if (!value || value.bytes <= CACHE_BYTES) {
    mapCache.set(scriptUrl, { expires: Date.now() + CACHE_TTL_MS, value })
    let bytes = [...mapCache.values()].reduce((sum, entry) => sum + (entry.value?.bytes ?? 0), 0)
    while (mapCache.size > CACHE_MAX || bytes > CACHE_BYTES) {
      const oldest = mapCache.keys().next().value
      if (oldest === undefined) break
      bytes -= mapCache.get(oldest)?.value?.bytes ?? 0
      mapCache.delete(oldest)
    }
  }
  return value
}

async function mapPosition(
  scriptUrl: string,
  line: number,
  column: number,
): Promise<MappedPosition | null> {
  const loaded = await loadMap(scriptUrl)
  if (!loaded) return null
  // V8 columns are 1-based, source-map columns 0-based
  const generated = { line, column: Math.max(0, column - 1) }
  for (const bias of [
    SourceMapConsumer.GREATEST_LOWER_BOUND,
    SourceMapConsumer.LEAST_UPPER_BOUND,
  ]) {
    const pos: { source: string | null; line: number | null; column: number | null } =
      loaded.consumer.originalPositionFor({ ...generated, bias })
    if (!pos.source || pos.line === null || pos.line < 1) continue
    // sourceRoot is already applied by the consumer; resolve what's still relative
    const source =
      SCHEME.test(pos.source) || pos.source.startsWith('/')
        ? pos.source
        : resolveUrl(pos.source, loaded.baseUrl)
    return { source, line: pos.line, column: pos.column == null ? undefined : pos.column + 1 }
  }
  return null
}

parentPort?.on('message', async ({ scriptUrl, line, column }: MapRequest) => {
  try {
    const result = await mapPosition(scriptUrl, line, column)
    parentPort?.postMessage({ result })
  } catch {
    // Malformed/unavailable maps fall back to approximate locations in the caller.
    parentPort?.postMessage({ result: null })
  }
})
