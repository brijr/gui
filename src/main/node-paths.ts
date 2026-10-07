import { join } from 'node:path'
import { app } from 'electron'

/**
 * The Node.js Gui downloads for Macs that have none (see node-runtime.ts): the official
 * LTS build from nodejs.org, pinned to these SHA-256 sums from its SHASUMS256.txt. Bump the
 * version and both sums together.
 */
export const NODE = {
  version: '24.21.0',
  sha256: {
    'darwin-arm64': '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
    'darwin-x64': '0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299',
  } as Record<string, string>,
}

/** Where Gui keeps its Node.js: one folder per version, of which only the pinned one stays. */
export const nodeRoot = () => join(app.getPath('userData'), 'runtimes', 'node')

/** The `bin` folder of Gui's Node.js (`node`, `npm`, `npx`), installed or not. */
export const nodeBinDir = () => join(nodeRoot(), NODE.version, 'bin')
