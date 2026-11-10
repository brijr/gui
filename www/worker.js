// Sends www.usegui.com and http:// to https://usegui.com, so search engines see one site.
// /releases/ is the app's update feed and builds, from the gui-releases R2 bucket
// (scripts/release.sh publishes there), and /download is the newest DMG, whatever its channel,
// counted in the gui-www D1 database. Both send the part of a file a Range header asks for, so
// an update downloads only what changed and an interrupted download can resume. /downloads is
// that count as one number, for the homepage. /waitlist adds an address to the Windows and
// Linux waitlist in the same database, and /crash keeps the crash reports installed copies send
// (src/main/crash-reports.ts). Everything else is the static site in dist/ (with dist/404.html
// for pages that don't exist); its videos are sent in parts too.

/** What /download serves: the copy of the newest DMG every release uploads, alpha or stable. */
const DOWNLOAD = 'Gui-arm64.dmg'
/** What /download serves until a release has uploaded that copy: the newest alpha DMG. */
const DOWNLOAD_ALPHA = 'Gui-alpha-arm64.dmg'

/**
 * @typedef {{ offset: number, length: number }} ByteRange
 * @typedef {{
 *   size: number
 *   etag: string
 *   httpEtag: string
 *   writeHttpMetadata(headers: Headers): void
 * }} R2Object
 * @typedef {R2Object & { body: ReadableStream }} R2ObjectBody
 * @typedef {{
 *   head(key: string): Promise<R2Object | null>
 *   get(
 *     key: string,
 *     options?: { range?: ByteRange, onlyIf?: { etagMatches: string } },
 *   ): Promise<R2ObjectBody | R2Object | null>
 * }} R2Bucket
 * @typedef {{
 *   bind(...values: unknown[]): D1Statement
 *   first(): Promise<Record<string, unknown> | null>
 *   run(): Promise<{ meta: { changes: number } }>
 * }} D1Statement
 * @typedef {{ prepare(sql: string): D1Statement }} D1Database
 * @typedef {{ ASSETS: { fetch: typeof fetch }, RELEASES: R2Bucket, DB: D1Database }} Env
 * @typedef {{ waitUntil(promise: Promise<unknown>): void }} Context
 */
export default {
  /** @param {Request} request @param {Env} env @param {Context} ctx */
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.hostname.startsWith('www.') || url.protocol === 'http:') {
      url.hostname = url.hostname.replace(/^www\./, '')
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }
    if (url.pathname === '/download') {
      // Gui is a Mac app. A phone goes back to the page, which says so, and is not counted.
      // (iPadOS says it is a Mac; the page's script handles it.)
      if (/iPhone|iPod|Android/.test(request.headers.get('user-agent') ?? '')) {
        return Response.redirect(new URL('/#mac-only', request.url).toString(), 303)
      }
      let file = DOWNLOAD
      let response = await release(request, env, file, 'Gui.dmg')
      if (response.status === 404) {
        file = DOWNLOAD_ALPHA
        response = await release(request, env, file, 'Gui.dmg')
      }
      if (response.ok && startsDownload(request)) ctx.waitUntil(countDownload(request, env, file))
      return response
    }
    if (url.pathname === '/downloads') return countedDownloads(request, env, ctx)
    if (url.pathname === '/waitlist' && request.method === 'POST') return waitlist(request, env)
    if (url.pathname === '/crash' && request.method === 'POST') return crash(request, env)
    const file = url.pathname.match(/^\/releases\/([\w.-]+)$/)?.[1]
    if (file) return release(request, env, file)
    const asset = await env.ASSETS.fetch(request)
    const video = url.pathname.startsWith('/video/')
    return secure(video ? await inParts(request, asset) : asset, url.pathname)
  },
}

/**
 * The hero videos keep their names when they change, so a browser keeps one for an hour and
 * then asks whether it is still the current one.
 */
const VIDEO_CACHE = 'public, max-age=3600'

/** The site's pages and files, with the headers that keep browsers on HTTPS and off frames. */
function secure(/** @type {Response} */ asset, /** @type {string} */ pathname) {
  const response = new Response(asset.body, asset)
  let cache = 'no-cache'
  if (pathname.startsWith('/_astro/') && asset.ok) cache = 'public, max-age=31536000, immutable'
  // A 304 renews the copy a browser kept, so it carries the video's rule as well.
  if (pathname.startsWith('/video/') && (asset.ok || asset.status === 304)) cache = VIDEO_CACHE
  response.headers.set('cache-control', cache)
  protect(response.headers)
  return response
}

/**
 * A video with the part of it a Range header asks for. The static site sends the whole file
 * whatever was asked, and Safari only plays a video it can fetch in parts. The videos are a few
 * hundred kilobytes, so the part is cut from the whole file here.
 * @param {Request} request @param {Response} asset
 */
async function inParts(request, asset) {
  if (asset.status !== 200) return asset
  const headers = new Headers(asset.headers)
  headers.set('accept-ranges', 'bytes')
  if (request.method !== 'GET' || !request.headers.has('range')) {
    return new Response(asset.body, { headers })
  }
  const bytes = await asset.arrayBuffer()
  const range = wantedRange(request, bytes.byteLength, headers.get('etag'))
  if (range === false) return unsatisfiable(bytes.byteLength)
  if (!range) return new Response(bytes, { headers })
  headers.set('content-range', contentRange(range, bytes.byteLength))
  headers.set('content-length', String(range.length))
  const part = bytes.slice(range.offset, range.offset + range.length)
  return new Response(part, { status: 206, headers })
}

/**
 * A file from the releases bucket: all of it, or the one range of bytes a GET asks for.
 * @param {Request} request @param {{ RELEASES: R2Bucket }} env @param {string} key
 * @param {string} [filename]
 */
async function release(request, env, key, filename) {
  // The size and ETag come first: a range is worked out from them, and a HEAD needs no more.
  const known = await env.RELEASES.head(key)
  if (!known) return new Response('Not found', { status: 404 })
  const range = wantedRange(request, known.size, known.httpEtag)
  if (range === false) return unsatisfiable(known.size)

  const respond = (/** @type {R2Object} */ object, /** @type {ByteRange | null} */ part) => {
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('accept-ranges', 'bytes')
    headers.set('content-length', String(part ? part.length : object.size))
    if (part) headers.set('content-range', contentRange(part, object.size))
    // Feeds and /download change with every release; versioned builds never do.
    const changes = key.endsWith('.yml') || filename
    headers.set('cache-control', changes ? 'no-cache' : 'public, max-age=31536000, immutable')
    if (filename) headers.set('content-disposition', `attachment; filename="${filename}"`)
    const body = 'body' in object ? /** @type {R2ObjectBody} */ (object).body : null
    return new Response(body, { status: part ? 206 : 200, headers })
  }

  if (request.method === 'HEAD') return respond(known, null)
  if (range) {
    // The range was worked out for one version, so R2 only sends it from that version. If a
    // release replaced the file a moment ago, the whole new file is sent instead.
    const part = await env.RELEASES.get(key, { range, onlyIf: { etagMatches: known.etag } })
    if (part && 'body' in part) return respond(part, range)
  }
  const whole = await env.RELEASES.get(key)
  return whole ? respond(whole, null) : new Response('Not found', { status: 404 })
}

/**
 * The part of a file a request asks for: null for all of it, false when the file has none of
 * the bytes asked for. Only a GET for one range gets a part. A request for several ranges gets
 * the whole file, and so does a resumed download whose If-Range names another version, so it
 * never continues with a slice of a different file.
 * @param {Request} request @param {number} size @param {string | null} etag
 * @returns {ByteRange | null | false}
 */
function wantedRange(request, size, etag) {
  const ifRange = request.headers.get('if-range')
  if (request.method !== 'GET' || (ifRange !== null && ifRange !== etag)) return null
  const [, first, last] = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/i) ?? []
  if (!first && !last) return null
  if (!first) {
    // bytes=-n is the last n bytes.
    const length = Math.min(Number(last), size)
    return length > 0 && { offset: size - length, length }
  }
  const offset = Number(first)
  // An end before the start is not a range at all, so the header is ignored.
  if (last && Number(last) < offset) return null
  const end = last ? Math.min(Number(last), size - 1) : size - 1
  return offset < size && { offset, length: end - offset + 1 }
}

function contentRange(/** @type {ByteRange} */ range, /** @type {number} */ size) {
  return `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`
}

/** The answer to a range that has none of the file's bytes in it. */
function unsatisfiable(/** @type {number} */ size) {
  return new Response(null, {
    status: 416,
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${size}` },
  })
}

/** Crawlers and link previews, which fetch /download but are not people downloading Gui. */
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless/i

/**
 * A person's GET from the first byte: not a HEAD, not a resumed download asking for the rest,
 * and not a crawler or link preview.
 */
function startsDownload(/** @type {Request} */ request) {
  if (request.method !== 'GET' || BOT.test(request.headers.get('user-agent') ?? '')) return false
  const range = request.headers.get('range')
  return !range || /^bytes=0-/.test(range)
}

/** @param {Request} request @param {Env} env @param {string} file The DMG that was sent. */
async function countDownload(request, env, file) {
  // Only the referring site, not the full address, so no query strings are kept.
  const referrer = URL.parse(request.headers.get('referer') ?? '')?.hostname ?? null
  try {
    await env.DB.prepare(
      'INSERT INTO downloads (file, country, referrer, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(file, country(request), referrer, now())
      .run()
  } catch (error) {
    console.error('download count failed', error)
  }
}

/** How long a homepage can keep the count, so D1 is not queried on every view. */
const COUNT_MAX_AGE = 300

/**
 * The public total from the downloads table: one number, and none of the row fields.
 * Auto-updates through /releases/ are not in this table.
 * @param {Request} request @param {Env} env @param {Context} ctx
 */
async function countedDownloads(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  const cache = globalThis.caches?.default
  const key = new Request(new URL('/downloads', request.url), { method: 'GET' })
  const hit = await cache?.match(key).catch(() => null)
  if (hit) return hit
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS downloads FROM downloads').first()
    const downloads = Number(row?.downloads)
    if (!Number.isInteger(downloads) || downloads < 0) return omitCount()
    const response = countResponse(downloads)
    if (cache) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}))
    return response
  } catch (error) {
    console.error('download count failed', error)
    return omitCount()
  }
}

function countResponse(/** @type {number} */ downloads) {
  const headers = new Headers({ 'cache-control': `public, max-age=${COUNT_MAX_AGE}` })
  protect(headers)
  return Response.json({ downloads }, { headers })
}

function omitCount() {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

/** The same browser rules as the pages, so this JSON is not framed and stays on HTTPS. */
function protect(/** @type {Headers} */ headers) {
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  headers.set('referrer-policy', 'strict-origin-when-cross-origin')
}

const PLATFORMS = new Set(['windows', 'linux'])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Adds an address to the waitlist. The page's script asks for JSON; without the script, the
 * form posts here and goes back to the page, where #waitlist-joined shows the confirmation.
 * @param {Request} request @param {Env} env
 */
async function waitlist(request, env) {
  const json = request.headers.get('accept')?.includes('application/json')
  const form = await request.formData().catch(() => null)
  const email = String(form?.get('email') ?? '').trim()
  const platform = String(form?.get('platform') ?? '')
  // A field people don't see: a bot that fills it in gets the usual answer and is not saved.
  const bot = String(form?.get('website') ?? '') !== ''
  if (email.length > 254 || !EMAIL.test(email) || !PLATFORMS.has(platform)) {
    return json
      ? Response.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 })
      : new Response('Enter a valid email address.', { status: 400 })
  }
  if (!bot) {
    await env.DB.prepare(
      'INSERT INTO waitlist (email, platform, country, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
    )
      .bind(email, platform, country(request), now())
      .run()
  }
  if (json) return Response.json({ ok: true })
  return Response.redirect(new URL('/#waitlist-joined', request.url).toString(), 303)
}

/** The app's report is a few kilobytes; anything much larger isn't one. */
const MAX_CRASH = 16_000
const CRASH_KINDS = new Set(['main', 'rejection', 'renderer', 'window', 'process'])

/** Keeps a crash report from Gui. @param {Request} request @param {Env} env */
async function crash(request, env) {
  const text = await request.text()
  if (text.length > MAX_CRASH) return new Response(null, { status: 413 })
  /** @type {Record<string, unknown> | null} */
  const report = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()
  const field = (/** @type {string} */ key, /** @type {number} */ max) =>
    typeof report?.[key] === 'string' ? report[key].slice(0, max) : null
  const kind = field('kind', 20)
  const message = field('message', 1000)
  const version = field('version', 40)
  if (!kind || !CRASH_KINDS.has(kind) || !message || !version) {
    return new Response(null, { status: 400 })
  }
  await env.DB.prepare(
    'INSERT INTO crashes (kind, message, stack, version, os, arch, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      kind,
      message,
      field('stack', 8000),
      version,
      field('os', 40),
      field('arch', 20),
      country(request),
      now(),
    )
    .run()
  return new Response(null, { status: 204 })
}

/** The two-letter country Cloudflare gives each request, if any. */
function country(/** @type {Request & { cf?: { country?: string } }} */ request) {
  return request.cf?.country ?? null
}

function now() {
  return Math.floor(Date.now() / 1000)
}
