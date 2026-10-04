// A dev server with no registry dependencies, so installing works offline. It imports
// a local package, so it only starts once `bun install` has linked it into node_modules.
import heading from 'greeting'

const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(`<!doctype html><title>${heading}</title><h1>${heading}</h1>`, {
      headers: { 'content-type': 'text/html' },
    }),
})

console.log(`Local: ${server.url}`)
