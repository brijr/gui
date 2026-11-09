import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { agentBinaries } from './scripts/agent-binaries'

/** Strict CSP for packaged builds; dev needs inline scripts for React Refresh. */
const csp: Plugin = {
  name: 'gui-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      injectTo: 'head-prepend',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: gui-thumb:; media-src 'self' blob: gui-recording:; font-src 'self' data:",
      },
    },
  ],
}

/**
 * ghostty-web inlines its wasm as base64 (~560 kB) for callers that pass no path.
 * The terminal always loads the separate ghostty-vt.wasm, so drop the inline copy.
 */
const ghosttyInlineWasm: Plugin = {
  name: 'gui-ghostty-inline-wasm',
  apply: 'build',
  transform(code, id) {
    if (!id.endsWith('/ghostty-web/dist/ghostty-web.js')) return
    const stripped = code.replace(
      /data:application\/wasm;base64,[A-Za-z0-9+/=]+/,
      'data:application/wasm;base64,',
    )
    if (stripped === code) this.warn('ghostty-web no longer inlines its wasm; remove this plugin')
    return stripped
  },
}

export default defineConfig({
  main: {
    // Minified (electron-vite leaves it off), keeping function and class names so stack
    // traces in crash reports still say where they came from.
    build: {
      externalizeDeps: true,
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'source-map-worker': resolve('src/main/source-map-worker.ts'),
          'history-worker': resolve('src/main/history-worker.ts'),
          'history-read-worker': resolve('src/main/history-read-worker.ts'),
        },
      },
    },
    esbuild: { keepNames: true },
    // Agent CLIs aren't bundled; this pins the versions (and hashes) Gui downloads.
    define: {
      __GUI_AGENT_BINARIES__: JSON.stringify(agentBinaries(resolve('.'))),
      // Set by scripts/release.sh; see src/main/official-build.ts.
      __GUI_OFFICIAL_BUILD__: JSON.stringify(process.env.GUI_OFFICIAL_BUILD === '1'),
      __GUI_ACCOUNTS_URL__: JSON.stringify(
        process.env.GUI_ACCOUNTS_URL ?? 'https://accounts.usegui.com',
      ),
    },
  },
  preload: {
    // Sandboxed preloads must be CommonJS.
    // `preview` is the preview's own: text edits in place, and the guides (src/preload/preview.ts).
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          preview: resolve('src/preload/preview.ts'),
        },
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    // The entity decoder's default entry uses its data table, so it works in both the
    // chat and its parser worker. Its browser entry requires document.createElement.
    resolve: {
      alias: {
        'decode-named-character-reference': createRequire(import.meta.url).resolve(
          'decode-named-character-reference',
        ),
      },
    },
    // Keep Gui's own UI server off 5173/3000 so it never collides with the projects it previews.
    server: { port: 5737, strictPort: true },
    plugins: [
      react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
      tailwindcss(),
      csp,
      ghosttyInlineWasm,
    ],
    build: {
      // electron-vite leaves it off; every tab's chat view parses this code again.
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          chat: resolve('src/renderer/chat.html'),
          settings: resolve('src/renderer/settings.html'),
          pick: resolve('src/renderer/pick.html'),
          guides: resolve('src/renderer/guides.html'),
        },
      },
    },
  },
})
