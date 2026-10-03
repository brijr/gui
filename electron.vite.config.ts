import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/** Strict CSP for packaged builds; dev needs inline scripts for React Refresh. */
const csp: Plugin = {
  name: 'grat-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      injectTo: 'head-prepend',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
      },
    },
  ],
}

export default defineConfig({
  main: {
    build: { externalizeDeps: true },
  },
  preload: {
    // Sandboxed preloads must be CommonJS.
    build: { externalizeDeps: true, rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } }), tailwindcss(), csp],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          chat: resolve('src/renderer/chat.html'),
        },
      },
    },
  },
})
