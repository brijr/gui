import { Database } from 'bun:sqlite'
import worker from '../../www/worker.js'

// Run after `bun run --cwd www build`. Data stays in memory; this never sends email.
const projectRoot = new URL('../../', import.meta.url).pathname
const root = `${projectRoot}www/dist/`
const db = new Database(':memory:')
db.exec(await Bun.file(`${projectRoot}www/migrations/0001_waitlist_downloads.sql`).text())
const env = {
  DB: {
    prepare: (sql: string) => ({
      bind: (...values: Array<string | number | null>) => ({
        run: async () => ({ meta: { changes: db.query(sql).run(...values).changes } }),
      }),
    }),
  },
  RELEASES: {
    get: async (key: string) => {
      if (key !== 'Gui-alpha-arm64.dmg') return null
      const file = Bun.file(`${projectRoot}release/Gui-0.1.0-alpha.7-arm64.dmg`)
      return {
        body: file.stream(),
        httpEtag: 'local-alpha-7',
        writeHttpMetadata: (headers: Headers) =>
          headers.set('content-type', 'application/x-apple-diskimage'),
      }
    },
  },
  ASSETS: {
    fetch: async (request: Request) => {
      const path = decodeURIComponent(new URL(request.url).pathname)
      for (const candidate of [path, `${path}.html`, `${path}index.html`]) {
        if (candidate.includes('..')) return new Response(null, { status: 400 })
        const file = Bun.file(root + candidate.replace(/^\/+/, ''))
        if (!candidate.endsWith('/') && (await file.exists())) return new Response(file)
      }
      return new Response(Bun.file(`${root}404.html`), { status: 404 })
    },
  },
}
Bun.serve({
  hostname: '127.0.0.1',
  port: 4331,
  fetch: async (request) => {
    const url = new URL(request.url)
    url.protocol = 'https:'
    const workerResult = await worker.fetch(new Request(url, request), env, {
      waitUntil: (p: Promise<unknown>) => p.catch(console.error),
    })
    const result = new Response(workerResult.body, workerResult)
    result.headers.delete('strict-transport-security')
    const location = result.headers.get('location')
    if (location) result.headers.set('location', location.replace('https:', 'http:'))
    return result
  },
})
let nextByte = 0
Bun.serve({
  hostname: '127.0.0.1',
  port: 4332,
  fetch: async (request) => {
    const url = new URL(request.url)
    url.port = '4331'
    const headers = new Headers(request.headers)
    headers.set(
      'user-agent',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    )
    const response = await fetch(new Request(url, request), { headers, redirect: 'manual' })
    await Bun.sleep(400)
    const reader = response.body?.getReader()
    let cancelled = false
    const body = reader
      ? new ReadableStream({
          async pull(controller) {
            try {
              const { value, done } = await reader.read()
              if (cancelled) return
              if (done) {
                controller.close()
                return
              }
              for (let offset = 0; offset < value.length; offset += 2048) {
                const chunk = value.slice(offset, offset + 2048)
                nextByte = Math.max(Date.now(), nextByte) + chunk.length / 50
                await Bun.sleep(Math.max(0, nextByte - Date.now()))
                if (cancelled) return
                controller.enqueue(chunk)
              }
            } catch (error) {
              if (!cancelled) controller.error(error)
            }
          },
          cancel() {
            cancelled = true
            return reader.cancel().catch(() => {})
          },
        })
      : null
    const outHeaders = new Headers(response.headers)
    outHeaders.set('cache-control', 'no-store')
    outHeaders.delete('strict-transport-security')
    const location = outHeaders.get('location')
    if (location) outHeaders.set('location', location.replace(':4331', ':4332'))
    return new Response(body, { status: response.status, headers: outHeaders })
  },
})
console.log(
  'QA worker: 4331; mobile server throttle: 4332, shared 400 kbit/s + 400ms latency; memory-only database',
)
