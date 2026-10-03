import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type RawSourceMap, SourceMapConsumer } from 'source-map-js'

export interface StackFrame {
  url: string
  line: number
  column: number
  functionName?: string
}

export interface SourceLocation {
  file: string // POSIX path relative to projectRoot
  line: number // 1-based
  column?: number // 1-based if known
  approximate: boolean // true when no real source map was applied
}

interface IndexSourceMap {
  version: number | string
  sections: unknown[]
}

type SourceMapInput = RawSourceMap | IndexSourceMap

interface LoadedMap {
  consumer: SourceMapConsumer
  baseUrl: string // URL relative sources resolve against
}

interface MappedPosition {
  source: string
  line: number
  column: number | undefined
}

const FETCH_TIMEOUT_MS = 3000
const MAX_FETCH_BYTES = 32 * 1024 * 1024
const CACHE_TTL_MS = 5000
const CACHE_MAX = 20
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

const FRAME_WITH_FN = /^\s*at\s+(?<fn>.+?)\s+\((?<url>.+):(?<line>\d+):(?<col>\d+)\)\s*$/
const FRAME_BARE = /^\s*at\s+(?:async\s+)?(?<url>\S.*):(?<line>\d+):(?<col>\d+)\s*$/
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABS = /^[a-z]:\//i
const SOURCE_MAPPING_URL = /\/[/*][#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g

const FRAMEWORK_URL = new RegExp(
  [
    '^node:',
    '/node_modules/',
    'node_modules_', // Turbopack chunk names
    '/\\.vite/deps/',
    '/@vite/',
    '/@react-refresh',
    '/@id/',
    'react-dom',
    'react[-_]jsx[-_](?:dev[-_])?runtime',
    'react-server-dom',
    '/next/dist/',
    '\\[turbopack\\]',
    '/_next/static/chunks/(?:turbopack-|webpack[.-]|main-app[.-]|main[.-]|framework[.-]|polyfills[.-]|react-refresh[.-])',
  ].join('|'),
)
const FRAMEWORK_FN = /(?:^|\.)(?:jsxDEV|jsxs?|createElement|jsxWithValidation\w*)$/

// source-map-js handles index maps (`sections`) at runtime; its typings only declare RawSourceMap
const MapConsumer = SourceMapConsumer as unknown as new (map: SourceMapInput) => SourceMapConsumer

const mapCache = new Map<string, { expires: number; value: Promise<LoadedMap | null> }>()

export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  for (const raw of stack.split('\n')) {
    const withFn = FRAME_WITH_FN.exec(raw)
    const groups = (withFn ?? FRAME_BARE.exec(raw))?.groups
    const url = groups?.url
    const line = Number(groups?.line)
    const column = Number(groups?.col)
    if (!url || !Number.isFinite(line) || !Number.isFinite(column)) continue
    // eval frames report positions inside the eval'd code, not the script
    if (url.includes('eval at ') || url.includes('<anonymous>')) continue
    const frame: StackFrame = { url, line, column }
    const fn = withFn?.groups?.fn?.replace(/^async\s+/, '')
    if (fn) frame.functionName = fn
    frames.push(frame)
  }
  return frames
}

export function isFrameworkFrame(frame: StackFrame): boolean {
  if (FRAMEWORK_URL.test(safeDecode(frame.url))) return true
  return frame.functionName !== undefined && FRAMEWORK_FN.test(frame.functionName)
}

export function normalizeSourcePath(source: string, projectRoot: string): string | null {
  const roots = projectRoots(projectRoot)
  let s = source.trim().replace(/\\/g, '/')
  // Turbopack module idents can carry a " [app-client] (ecmascript)" suffix
  s = s.replace(/\s+\[[^\]]+\](?:\s+\([^)]*\))*\s*$/, '')
  const lower = s.toLowerCase()

  if (lower.startsWith('turbopack://')) {
    const rest = safeDecode(stripQuery(s.slice('turbopack://'.length))).replace(/^\/+/, '')
    return rest.startsWith('[project]/') ? cleanRelative(rest.slice('[project]/'.length)) : null
  }
  if (lower.startsWith('webpack-internal://')) {
    return fromWebpackPath(s.slice('webpack-internal://'.length).replace(/^\/+/, ''), roots)
  }
  if (lower.startsWith('webpack://')) {
    let rest = s.slice('webpack://'.length)
    if (rest.startsWith('/')) {
      rest = rest.slice(1)
      if (!/^[.(]/.test(rest)) rest = `/${rest}` // webpack:///abs/path
    } else if (!rest.startsWith('.')) {
      rest = rest.replace(/^[^/]*\/?/, '') // drop namespace, e.g. _N_E
    }
    return fromWebpackPath(rest, roots)
  }
  if (lower.startsWith('file://')) {
    try {
      return fromAbsolute(fileURLToPath(stripQuery(s)), roots)
    } catch {
      return null
    }
  }
  if (/^https?:\/\//.test(lower)) {
    try {
      return fromRootedPath(safeDecode(new URL(s).pathname), roots)
    } catch {
      return null
    }
  }
  if (SCHEME.test(s) && !WINDOWS_ABS.test(s)) return null

  s = stripQuery(s)
  if (s.startsWith('/') || WINDOWS_ABS.test(s)) return fromRootedPath(s, roots)
  return cleanRelative(s)
}

/**
 * `origin` restricts which server we fetch scripts and maps from. Stacks come from
 * the previewed page, so without it a page could make us probe any loopback port.
 */
export async function resolveFrame(
  frame: StackFrame,
  projectRoot: string,
  origin?: string,
): Promise<SourceLocation | null> {
  try {
    const { url, line, column } = frame
    if (!Number.isInteger(line) || line < 1) return null

    if (/^webpack-internal:/i.test(url)) {
      return await locate(normalizeSourcePath(url, projectRoot), line, undefined, true, projectRoot)
    }

    if (/^https?:/i.test(url)) {
      const parsed = new URL(url)
      if (!LOCAL_HOSTS.has(parsed.hostname)) return null
      const mapped =
        !origin || parsed.origin === origin ? await mapPosition(parsed.href, line, column) : null
      if (mapped) {
        const rel = normalizeSourcePath(mapped.source, projectRoot)
        const loc = await locate(rel, mapped.line, mapped.column, false, projectRoot)
        if (loc) return loc
      }
      // e.g. Vite serving /src/App.tsx without a usable map
      return await locate(normalizeSourcePath(url, projectRoot), line, undefined, true, projectRoot)
    }

    if (/^file:/i.test(url) || isAbsolute(url)) {
      return await locate(normalizeSourcePath(url, projectRoot), line, undefined, true, projectRoot)
    }
    return null
  } catch {
    return null
  }
}

export async function resolveStack(
  stack: string,
  projectRoot: string,
  origin?: string,
): Promise<SourceLocation | null> {
  for (const frame of parseStack(stack)) {
    if (isFrameworkFrame(frame)) continue
    const loc = await resolveFrame(frame, projectRoot, origin)
    if (loc) return loc
  }
  return null
}

// --- path helpers ---

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripQuery(value: string): string {
  return value.replace(/[?#].*$/, '')
}

function projectRoots(projectRoot: string): string[] {
  const abs = resolve(projectRoot)
  try {
    const real = realpathSync(abs)
    return real === abs ? [abs] : [abs, real]
  } catch {
    return [abs]
  }
}

function cleanRelative(value: string): string | null {
  const rel = posix.normalize(value.replace(/\\/g, '/')).replace(/^(?:\.\/)+/, '')
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/'))
    return null
  if (WINDOWS_ABS.test(rel) || rel.split('/').includes('node_modules')) return null
  return rel
}

function relativeToRoots(abs: string, roots: string[]): string | null {
  for (const root of roots) {
    const rel = relative(root, abs)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    return rel.split(sep).join('/')
  }
  return null
}

function fromAbsolute(abs: string, roots: string[]): string | null {
  const rel = relativeToRoots(abs, roots)
  return rel === null ? null : cleanRelative(rel)
}

// A leading-slash path is either an absolute fs path or a dev-server URL path (Vite's /src/x.tsx)
function fromRootedPath(path: string, roots: string[]): string | null {
  if (path.startsWith('/@fs/')) return fromAbsolute(path.slice('/@fs'.length), roots)
  if (path.startsWith('/@')) return null
  const rel = relativeToRoots(path, roots)
  if (rel !== null) return cleanRelative(rel)
  if (WINDOWS_ABS.test(path)) return null
  const first = path.split('/')[1]
  if (roots.some((root) => root.split(sep).filter(Boolean)[0] === first)) return null
  return cleanRelative(path.slice(1))
}

function fromWebpackPath(value: string, roots: string[]): string | null {
  const rest = stripQuery(value).replace(/^(?:\([^)]*\)\/)+/, '') // layer prefix, e.g. (app-pages-browser)/
  return rest.startsWith('/') ? fromAbsolute(rest, roots) : cleanRelative(rest)
}

// Turbopack's [project] can be a monorepo root above projectRoot; also try stripping a leading
// run of segments that matches projectRoot's tail (apps/web/components/x.tsx → components/x.tsx)
function candidatePaths(rel: string, projectRoot: string): string[] {
  const out = [rel]
  const relSegs = rel.split('/')
  const rootSegs = resolve(projectRoot).split(sep).filter(Boolean)
  for (let k = Math.min(rootSegs.length, relSegs.length - 1); k >= 1; k--) {
    const tail = rootSegs.slice(-k)
    if (tail.every((seg, i) => seg === relSegs[i])) out.push(relSegs.slice(k).join('/'))
  }
  return out
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function locate(
  rel: string | null,
  line: number,
  column: number | undefined,
  approximate: boolean,
  projectRoot: string,
): Promise<SourceLocation | null> {
  if (!rel) return null
  for (const file of candidatePaths(rel, projectRoot)) {
    if (!(await isFile(join(projectRoot, file)))) continue
    return column === undefined ? { file, line, approximate } : { file, line, column, approximate }
  }
  return null
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
  if (text === null) return null

  const raw: unknown = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, '')) // strip XSSI prefix
  if (!isSourceMapInput(raw)) return null
  return { consumer: new MapConsumer(raw), baseUrl }
}

function loadMap(scriptUrl: string): Promise<LoadedMap | null> {
  const now = Date.now()
  for (const [key, entry] of mapCache) if (entry.expires <= now) mapCache.delete(key)
  const hit = mapCache.get(scriptUrl)
  if (hit) return hit.value

  const value = fetchMap(scriptUrl).catch(() => null)
  mapCache.set(scriptUrl, { expires: now + CACHE_TTL_MS, value })
  while (mapCache.size > CACHE_MAX) {
    const oldest = mapCache.keys().next().value
    if (oldest === undefined) break
    mapCache.delete(oldest)
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
