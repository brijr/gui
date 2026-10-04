import { page } from '@gui-e2e/ui'

const server = Bun.serve({
  port: 0,
  fetch: () => new Response(page('docs'), { headers: { 'content-type': 'text/html' } }),
})

console.log(`Local: ${server.url}`)
