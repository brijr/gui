// Serves dist/ for the tests, as the Worker would: /brand gets brand.html, / gets index.html.
const root = new URL('../dist/', import.meta.url).pathname

Bun.serve({
  port: Number(process.env.PORT ?? 4329),
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname)
    for (const candidate of [path, `${path}.html`, `${path}index.html`]) {
      const file = Bun.file(root + candidate.replace(/^\/+/, ''))
      if (!candidate.endsWith('/') && (await file.exists())) return new Response(file)
    }
    return new Response(Bun.file(`${root}404.html`), { status: 404 })
  },
})
