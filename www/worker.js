// Sends www.usegui.com to usegui.com, so search engines see one site. Everything else is the
// static site in dist/ (with dist/404.html for pages that don't exist).
export default {
  /** @param {Request} request @param {{ ASSETS: { fetch: typeof fetch } }} env */
  fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4)
      return Response.redirect(url.toString(), 301)
    }
    return env.ASSETS.fetch(request)
  },
}
