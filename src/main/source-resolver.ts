import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackgroundWorker } from './background-worker'
import type { MappedPosition, MapRequest } from './source-map-protocol'

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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

const FRAME_WITH_FN = /^\s*at\s+(?<fn>.+?)\s+\((?<url>.+):(?<line>\d+):(?<col>\d+)\)\s*$/
const FRAME_BARE = /^\s*at\s+(?:async\s+)?(?<url>\S.*):(?<line>\d+):(?<col>\d+)\s*$/
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABS = /^[a-z]:\//i

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

const mapWorker = new BackgroundWorker<MapRequest, MappedPosition | null>(
  new URL(
    import.meta.url.endsWith('.ts') ? './source-map-worker.ts' : './source-map-worker.js',
    import.meta.url,
  ),
)

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
 * A filesystem path a page reported (absolute, or relative to the root) as a path
 * relative to `projectRoot`; null when it's outside the root or in node_modules.
 */
export function projectRelativePath(path: string, projectRoot: string): string | null {
  const s = path.trim().replace(/\\/g, '/')
  if (s.startsWith('/') || WINDOWS_ABS.test(s)) return fromAbsolute(s, projectRoots(projectRoot))
  return SCHEME.test(s) ? null : cleanRelative(s)
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

/** Main only exchanges small positions; parsing and map caches live in the worker. */
function mapPosition(scriptUrl: string, line: number, column: number) {
  return mapWorker.run({ scriptUrl, line, column }).catch(() => null)
}
