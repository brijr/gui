// Imports a sibling workspace package, so it only starts once the root install linked it.
import { page } from '@gui-e2e/ui'

const server = Bun.serve({
  port: 0,
  fetch: () => new Response(page('web'), { headers: { 'content-type': 'text/html' } }),
})

console.log(`Local: ${server.url}`)
