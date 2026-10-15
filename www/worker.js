// Sends www.usegui.com and http:// to https://usegui.com, so search engines see one site.
// /releases/ is the app's update feed and builds, from the gui-releases R2 bucket
// (scripts/release.sh publishes there), and /download is the newest DMG, counted in the gui-www
// D1 database. /waitlist adds an address to the Windows and Linux waitlist in the same database.
// Everything else is the static site in dist/ (with dist/404.html for pages that don't exist).

/** The channel /download serves: alpha until Gui has a stable release. */
const DOWNLOAD = 'Gui-alpha-arm64.dmg'

/**
 * @typedef {{ body: ReadableStream, httpEtag: string, writeHttpMetadata(headers: Headers): void }} R2Object
 * @typedef {{ get(key: string): Promise<R2Object | null> }} R2Bucket
 * @typedef {{ prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }> } } }} D1Database
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
      const response = await release(env, DOWNLOAD, 'Gui.dmg')
      if (response.ok && startsDownload(request)) ctx.waitUntil(countDownload(request, env))
      return response
    }
    if (url.pathname === '/waitlist' && request.method === 'POST') return waitlist(request, env)
    const file = url.pathname.match(/^\/releases\/([\w.-]+)$/)?.[1]
    if (file) return release(env, file)
    return secure(await env.ASSETS.fetch(request))
  },
}

/** The site's pages and files, with the headers that keep browsers on HTTPS and off frames. */
function secure(/** @type {Response} */ asset) {
  const response = new Response(asset.body, asset)
  response.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
  response.headers.set('x-content-type-options', 'nosniff')
  response.headers.set('x-frame-options', 'DENY')
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  return response
}

/** @param {{ RELEASES: R2Bucket }} env @param {string} key @param {string} [filename] */
async function release(env, key, filename) {
  const object = await env.RELEASES.get(key)
  if (!object) return new Response('Not found', { status: 404 })
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  // Feeds and /download change with every release; versioned builds never do.
  const changes = key.endsWith('.yml') || filename
  headers.set('cache-control', changes ? 'no-cache' : 'public, max-age=31536000, immutable')
  if (filename) headers.set('content-disposition', `attachment; filename="${filename}"`)
  return new Response(object.body, { headers })
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

/** @param {Request} request @param {Env} env */
async function countDownload(request, env) {
  // Only the referring site, not the full address, so no query strings are kept.
  const referrer = URL.parse(request.headers.get('referer') ?? '')?.hostname ?? null
  try {
    await env.DB.prepare(
      'INSERT INTO downloads (file, country, referrer, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(DOWNLOAD, country(request), referrer, now())
      .run()
  } catch (error) {
    console.error('download count failed', error)
  }
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

/** The two-letter country Cloudflare gives each request, if any. */
function country(/** @type {Request & { cf?: { country?: string } }} */ request) {
  return request.cf?.country ?? null
}

function now() {
  return Math.floor(Date.now() / 1000)
}
