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
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: gui-thumb:; media-src 'self' blob: gui-recording:; font-src 'self' data:",
      },
    },
  ],
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
        },
      },
    },
    esbuild: { keepNames: true },
    // Agent CLIs aren't bundled; this pins the versions (and hashes) Gui downloads.
    define: {
      __GUI_AGENT_BINARIES__: JSON.stringify(agentBinaries(resolve('.'))),
      __GUI_ACCOUNTS_URL__: JSON.stringify(
        process.env.GUI_ACCOUNTS_URL ?? 'https://accounts.usegui.com',
      ),
    },
  },
  preload: {
    // Sandboxed preloads must be CommonJS.
    build: { externalizeDeps: true, rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    // Keep Gui's own UI server off 5173/3000 so it never collides with the projects it previews.
    server: { port: 5737, strictPort: true },
    plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } }), tailwindcss(), csp],
    build: {
      // electron-vite leaves it off; every tab's chat view parses this code again.
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          chat: resolve('src/renderer/chat.html'),
          settings: resolve('src/renderer/settings.html'),
          pick: resolve('src/renderer/pick.html'),
        },
      },
    },
  },
})
