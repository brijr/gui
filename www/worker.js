// Sends www.usegui.com and http:// to https://usegui.com, so search engines see one site.
// /releases/ is the app's update feed and builds, from the gui-releases R2 bucket
// (scripts/release.sh and scripts/publish-linux.sh publish there), and /download is the newest
// DMG, whatever its channel, counted in the gui-www D1 database; on Linux it is the download page,
// whose /download/<file> links are counted the same way. Both send the part of a file a Range
// header asks for, so
// an update downloads only what changed and an interrupted download can resume. /downloads is
// that count as one number, for the homepage. /waitlist adds an address to the Windows
// waitlist in the same database, and /crash keeps the crash reports installed copies send
// (src/main/crash-reports.ts). /t/v1 takes the app's usage events (src/main/analytics.ts) and
// passes the ones it knows on to PostHog, so where they are kept can change here without a
// new app; update feed requests are counted the same way. Everything else is the static site in dist/ (with dist/404.html
// for pages that don't exist); its videos are sent in parts too, and /install.sh, the Linux
// install script, is sent as plain text. /crash, /waitlist and /t/v1 refuse an address that
// sends more than the limits in wrangler.jsonc allow; downloads and feed requests past a limit
// are still sent, just not counted.

/**
 * What /download serves: the newest stable release's DMG. Until a stable release has uploaded
 * it, the newest alpha's, Gui-alpha-arm64.dmg (`newest`).
 */
const DOWNLOAD = 'Gui-arm64.dmg'
/** The Linux builds the download page links to as /download/<name>, chosen the same way. */
const LINUX_DOWNLOADS = new Set([
  'Gui-x86_64.AppImage',
  'Gui-arm64.AppImage',
  'Gui-amd64.deb',
  'Gui-arm64.deb',
])

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
 * @typedef {{ limit(options: { key: string, delta?: number }): Promise<{ success: boolean }> }} RateLimit
 * @typedef {{
 *   ASSETS: { fetch: typeof fetch }
 *   RELEASES: R2Bucket
 *   DB: D1Database
 *   POSTHOG_KEY?: string
 *   POSTHOG_HOST?: string
 *   ANALYTICS?: string
 *   USAGE_LIMITER?: RateLimit
 *   CRASH_LIMITER?: RateLimit
 *   WAITLIST_LIMITER?: RateLimit
 *   COUNT_LIMITER?: RateLimit
 * }} Env
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
      const agent = request.headers.get('user-agent') ?? ''
      // Gui is for Macs and Linux computers. A phone goes back to the page, which says so, and
      // is not counted. (iPadOS says it is a Mac; the page's script handles it.)
      if (/iPhone|iPod|Android/.test(agent)) {
        return Response.redirect(new URL('/#mac-only', request.url).toString(), 303)
      }
      // Windows is not out yet. It goes back to the page, which says so and offers the waitlist,
      // and is not counted. Tools like curl say nothing about Windows and still get the DMG.
      if (/Windows/.test(agent)) {
        return Response.redirect(new URL('/#windows', request.url).toString(), 303)
      }
      // Linux gets the download page for its processor. Chrome always says x86_64, so that is
      // the default, and the page links to the other.
      if (/Linux/.test(agent)) {
        const page = /aarch64|arm64/i.test(agent) ? '/download/linux-arm64' : '/download/linux'
        return Response.redirect(new URL(page, request.url).toString(), 303)
      }
      return newest(request, env, ctx, DOWNLOAD, 'Gui.dmg')
    }
    const linux = url.pathname.match(/^\/download\/([\w.-]+)$/)?.[1]
    if (linux && LINUX_DOWNLOADS.has(linux)) return newest(request, env, ctx, linux, linux)
    if (url.pathname === '/downloads') return countedDownloads(request, env, ctx)
    if (url.pathname === '/waitlist' && request.method === 'POST') return waitlist(request, env)
    if (url.pathname === '/crash' && request.method === 'POST') return crash(request, env)
    if (url.pathname === '/t/v1' && request.method === 'POST') return usage(request, env, ctx)
    const file = url.pathname.match(/^\/releases\/([\w.-]+)$/)?.[1]
    if (file) {
      if (file.endsWith('.yml') && request.method === 'GET')
        countUpdateCheck(request, env, ctx, file)
      return release(request, env, file)
    }
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
  // The Linux install script (public/install.sh) is text to read in a browser, not a download.
  if (pathname === '/install.sh' && asset.ok)
    response.headers.set('content-type', 'text/plain; charset=utf-8')
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
 * The newest release's copy of a download, Gui-<name>, as an attachment named `filename`, and
 * counted. A stable release uploads that copy; until there is one, it is the newest alpha's,
 * Gui-alpha-<name>.
 * @param {Request} request @param {Env} env @param {Context} ctx @param {string} file
 * @param {string} filename
 */
async function newest(request, env, ctx, file, filename) {
  let response = await release(request, env, file, filename)
  if (response.status === 404) {
    file = file.replace(/^Gui-/, 'Gui-alpha-')
    response = await release(request, env, file, filename)
  }
  if (response.ok && startsDownload(request)) ctx.waitUntil(countDownload(request, env, file))
  return response
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
 * A person's GET for the whole file: no Range, or one from the first byte to the end. Not a
 * HEAD, not a part of the file (a resumed download asking for the rest, or a few bytes), and
 * not a crawler or link preview.
 */
function startsDownload(/** @type {Request} */ request) {
  if (request.method !== 'GET' || BOT.test(request.headers.get('user-agent') ?? '')) return false
  const range = request.headers.get('range')
  return range === null || /^bytes=0-$/i.test(range.trim())
}

/** @param {Request} request @param {Env} env @param {string} file The DMG that was sent. */
async function countDownload(request, env, file) {
  // One address counts a few downloads a minute at most; past that it is still sent the file.
  if (!(await underLimit(env.COUNT_LIMITER, 'download', request))) return
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

// The form only sends windows now. Linux is out, but a page cached from before it still
// offers linux, and that address is kept too.
const PLATFORMS = new Set(['windows', 'linux'])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Adds an address to the waitlist. The page's script asks for JSON; without the script, the
 * form posts here and goes back to the page, where #waitlist-joined shows the confirmation.
 * @param {Request} request @param {Env} env
 */
async function waitlist(request, env) {
  if (!(await underLimit(env.WAITLIST_LIMITER, 'waitlist', request))) return tooMany()
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
/**
 * The most reports kept in a day, from everyone. The busiest real day so far kept 164; past
 * this, reports are refused until the day's count falls, and none already kept are removed.
 */
const MAX_CRASHES_PER_DAY = 2000

/** Keeps a crash report from Gui. @param {Request} request @param {Env} env */
async function crash(request, env) {
  if (tooLarge(request, MAX_CRASH)) return new Response(null, { status: 413 })
  if (!(await underLimit(env.CRASH_LIMITER, 'crash', request))) return tooMany()
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
  const time = now()
  const { meta } = await env.DB.prepare(
    `INSERT INTO crashes (kind, message, stack, version, os, arch, country, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM crashes WHERE created_at > ?) < ?`,
  )
    .bind(
      kind,
      message,
      field('stack', 8000),
      version,
      field('os', 40),
      field('arch', 20),
      country(request),
      time,
      time - 86_400,
      MAX_CRASHES_PER_DAY,
    )
    .run()
  if (meta.changes === 0) return tooMany()
  return new Response(null, { status: 204 })
}

/**
 * The usage events the app may send, and the props each may carry: a pattern each value must
 * match, or the values it may be. Anything else (an event or prop not listed here, a value
 * that doesn't fit) is dropped, never kept. None of them can hold a path, a name, an address,
 * or anything the user wrote.
 */
const VERSION = /^[\w.+-]{1,40}$/
const NAME = /^[a-z][\w-]{0,39}$/i
const YES_NO = ['yes', 'no']
/** The same lists as the app's (src/main/analytics-queue.ts) */
const TURN_FAILURES = [
  'signed_out',
  'too_old',
  'agent_quit',
  'context_too_long',
  'no_credit',
  'servers_busy',
  'rate_limited',
  'server_error',
  'offline',
  'no_model',
  'bad_request',
  'timeout',
  'dropped',
  'denied',
  'tool_failed',
  'not_installed',
  'other',
]
/** Where a failed turn was (the app's analytics-queue.ts `TURN_STAGES`) */
const TURN_STAGES = ['start', 'reply', 'tool']
const FRAMEWORKS = [
  'next',
  'vite',
  'astro',
  'nuxt',
  'remix',
  'react-router',
  'angular',
  'gatsby',
  'react-scripts',
  'docusaurus',
  'vitepress',
  'parcel',
  'webpack',
  'vinxi',
  'other',
  'none',
  'unknown',
]
const UPDATE_FAILURES = [
  'offline',
  'dropped',
  'timeout',
  'http',
  'checksum',
  'signature',
  'disk_full',
  'permission',
  'read_only',
  'other',
]
/** Why an installed agent couldn't be used (the app's analytics-queue.ts `AGENT_UNAVAILABLE`) */
const AGENT_UNAVAILABLE = ['signed_out', 'too_old', 'agent_quit', 'offline', 'timeout', 'error']
/** @type {Record<string, Record<string, RegExp | string[]>>} */
const EVENTS = {
  app_opened: { version: VERSION, os: NAME, osVersion: VERSION, arch: NAME },
  turn_finished: {
    agent: NAME,
    outcome: ['done', 'failed', 'stopped'],
    provider: NAME,
    reason: TURN_FAILURES,
    stage: TURN_STAGES,
    picked: YES_NO,
    tools: YES_NO,
    mode: ['ask', 'auto', 'own'],
  },
  project_opened: { framework: FRAMEWORKS },
  canvas_created: {},
  preview_opened: {},
  app_start_failed: { reason: ['install_failed', 'command_missing', 'exited', 'other'] },
  agent_connected: { agent: NAME },
  agent_unavailable: {
    agent: NAME,
    reason: AGENT_UNAVAILABLE,
    current: YES_NO,
  },
  update_installed: { from: VERSION, to: VERSION },
  update_failed: { stage: ['download', 'install'], reason: UPDATE_FAILURES },
}
/** A batch is a few kilobytes; much more isn't one. */
const MAX_USAGE_BYTES = 64_000
const MAX_USAGE_EVENTS = 100
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** An event's time, if it's one the app could have queued: no older than a week, not ahead. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The kill switch, `ANALYTICS` in wrangler.jsonc: unset to keep everything, `off` to keep
 * nothing (the app stops sending until it next launches), or a comma list of events to drop.
 * @param {Env} env
 */
function usageSwitch(env) {
  const value = (env.ANALYTICS ?? '').trim()
  if (value === 'off') return { off: true, dropped: new Set() }
  return { off: false, dropped: new Set(value.split(',').map((name) => name.trim())) }
}

/**
 * Takes a batch of the app's usage events: `{ installId, events: [{ event, at, props }] }`.
 * The ones it knows go on to PostHog after the reply; the rest are dropped.
 * @param {Request} request @param {Env} env @param {Context} ctx
 */
async function usage(request, env, ctx) {
  const { off, dropped } = usageSwitch(env)
  if (off) return Response.json({ stop: true })
  if (tooLarge(request, MAX_USAGE_BYTES)) return new Response(null, { status: 413 })
  const text = await request.text()
  if (text.length > MAX_USAGE_BYTES) return new Response(null, { status: 413 })
  /** @type {any} */
  const batch = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()
  const installId = batch?.installId
  if (
    typeof installId !== 'string' ||
    !INSTALL_ID.test(installId) ||
    !Array.isArray(batch.events)
  ) {
    return new Response(null, { status: 400 })
  }
  // Counted by events, not requests: a batch of 100 is 100 toward the address's limit.
  const delta = Math.max(1, Math.min(batch.events.length, MAX_USAGE_EVENTS))
  if (!(await underLimit(env.USAGE_LIMITER, 'usage', request, delta))) return tooMany()
  const place = country(request)
  const events = []
  for (const raw of batch.events.slice(0, MAX_USAGE_EVENTS)) {
    const kept = usageEvent(raw, dropped)
    if (!kept) continue
    const props = { ...kept.props, country: place }
    events.push(posthogEvent(kept.event, installId.toLowerCase(), kept.at, props))
  }
  if (events.length > 0) ctx.waitUntil(forward(env, events))
  return new Response(null, { status: 204 })
}

/**
 * One event as the app sent it, with only the props its event allows; null for an event this
 * doesn't know or that was switched off.
 * @param {unknown} raw @param {Set<string>} dropped
 */
function usageEvent(raw, dropped) {
  if (!raw || typeof raw !== 'object') return null
  const { event, at, props } = /** @type {Record<string, unknown>} */ (raw)
  if (typeof event !== 'string' || !Object.hasOwn(EVENTS, event) || dropped.has(event)) return null
  const allowed = EVENTS[event]
  /** @type {Record<string, string>} */
  const kept = {}
  if (props && typeof props === 'object') {
    for (const [key, value] of Object.entries(props)) {
      const rule = Object.hasOwn(allowed, key) ? allowed[key] : null
      if (!rule || typeof value !== 'string') continue
      if (Array.isArray(rule) ? rule.includes(value) : rule.test(value)) kept[key] = value
    }
  }
  const now = Date.now()
  const time = typeof at === 'number' && at > now - MAX_AGE_MS && at <= now ? at : now
  return { event, at: time, props: kept }
}

/**
 * An event in PostHog's shape, with nothing that identifies the person: no IP (the request
 * PostHog sees is this worker's anyway), no location looked up from one, and no person
 * profile. `distinctId` is the install's random ID, or a fixed one for update checks.
 * @param {string} event @param {string} distinctId @param {number} at
 * @param {Record<string, string | null>} props
 */
function posthogEvent(event, distinctId, at, props) {
  return {
    event,
    distinct_id: distinctId,
    timestamp: new Date(at).toISOString(),
    properties: {
      ...props,
      $ip: null,
      $geoip_disable: true,
      $process_person_profile: false,
    },
  }
}

/**
 * Sends events to PostHog's batch API. Without POSTHOG_KEY (before the secret is set) they
 * are dropped. A failure is logged here; the app never hears of it.
 * @param {Env} env @param {object[]} events
 */
async function forward(env, events) {
  if (!env.POSTHOG_KEY) return
  const host = env.POSTHOG_HOST ?? 'https://us.i.posthog.com'
  try {
    const response = await fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch: events }),
    })
    if (!response.ok) console.error('usage forward failed', response.status)
  } catch (error) {
    console.error('usage forward failed', error)
  }
}

/**
 * An installed Gui asked the update feed for news: counted as an `update_check`, with the
 * feed's name, Gui's version (the app sends `Gui/<version>` as its user agent), and the
 * country. No install ID, so every check is one anonymous ID. Sent after the feed's reply;
 * nothing here can slow or fail it.
 * @param {Request} request @param {Env} env @param {Context} ctx @param {string} feed
 */
function countUpdateCheck(request, env, ctx, feed) {
  try {
    if (!env.POSTHOG_KEY) return
    const { off, dropped } = usageSwitch(env)
    if (off || dropped.has('update_check')) return
    const version = request.headers.get('user-agent')?.match(/\bGui\/([\w.+-]{1,40})/)?.[1] ?? null
    const event = posthogEvent('update_check', 'update-feed', Date.now(), {
      feed,
      version,
      country: country(request),
    })
    // One address counts a few checks a minute at most. The feed is sent either way.
    const counted = async () => {
      if (await underLimit(env.COUNT_LIMITER, 'update_check', request)) await forward(env, [event])
    }
    ctx.waitUntil(counted())
  } catch (error) {
    console.error('update check count failed', error)
  }
}

/**
 * Whether the client is still under `limiter`, one of the rate limits in wrangler.jsonc, for
 * `name`. Clients are told apart by IP address, and an IPv6 address by its /64, which one
 * home or office is given whole. Each call counts `delta` toward the limit. Without the
 * binding (local development), or if the limiter fails, the request goes through.
 * @param {RateLimit | undefined} limiter @param {string} name @param {Request} request
 * @param {number} [delta]
 */
async function underLimit(limiter, name, request, delta = 1) {
  if (!limiter) return true
  const key = `${name}:${client(request)}`
  try {
    const { success } = await limiter.limit(delta === 1 ? { key } : { key, delta })
    return success
  } catch (error) {
    console.error('rate limit failed', error)
    return true
  }
}

/** The client's address as rate limits count it: an IPv4 address, or an IPv6 /64. */
function client(/** @type {Request} */ request) {
  const ip = (request.headers.get('cf-connecting-ip') ?? '').trim().toLowerCase()
  if (!ip.includes(':')) return ip || 'unknown'
  const [head, tail] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const zeros = tail === undefined ? 0 : Math.max(0, 8 - left.length - right.length)
  const groups = [...left, ...Array(zeros).fill('0'), ...right]
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

/** A request that says its body is larger than `max` bytes, refused before it is read. */
function tooLarge(/** @type {Request} */ request, /** @type {number} */ max) {
  return Number(request.headers.get('content-length') ?? 0) > max
}

/** A client past its limit: nothing else is said. */
function tooMany() {
  return new Response(null, { status: 429 })
}

/** The two-letter country Cloudflare gives each request, if any. */
function country(/** @type {Request & { cf?: { country?: string } }} */ request) {
  return request.cf?.country ?? null
}

function now() {
  return Math.floor(Date.now() / 1000)
}
