import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://usegui.com',
  // brand.html, not brand/index.html: Cloudflare serves it at /brand, the canonical URL, and
  // sends /brand/ there. (A directory makes /brand a redirect to /brand/.)
  build: { format: 'file' },
  trailingSlash: 'never',
})
