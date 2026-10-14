// Sends www.usegui.com to usegui.com, so search engines see one site. /releases/ is the app's
// update feed and builds, from the gui-releases R2 bucket (scripts/release.sh publishes
// there), and /download is the newest DMG. Everything else is the static site in dist/ (with
// dist/404.html for pages that don't exist).

/** The channel /download serves: alpha until Gui has a stable release. */
const DOWNLOAD = 'Gui-alpha-arm64.dmg'

/**
 * @typedef {{ body: ReadableStream, httpEtag: string, writeHttpMetadata(headers: Headers): void }} R2Object
 * @typedef {{ get(key: string): Promise<R2Object | null> }} R2Bucket
 */
export default {
  /** @param {Request} request @param {{ ASSETS: { fetch: typeof fetch }, RELEASES: R2Bucket }} env */
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4)
      return Response.redirect(url.toString(), 301)
    }
    if (url.pathname === '/download') return release(env, DOWNLOAD, 'Gui.dmg')
    const file = url.pathname.match(/^\/releases\/([\w.-]+)$/)?.[1]
    if (file) return release(env, file)
    return env.ASSETS.fetch(request)
  },
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
