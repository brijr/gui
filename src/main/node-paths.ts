import { join } from 'node:path'
import { app } from 'electron'
import { IS_WINDOWS } from '../shared/platform'

/**
 * The Node.js Gui downloads for Macs that have none (see node-runtime.ts): the official
 * LTS build from nodejs.org, pinned to these SHA-256 sums from its SHASUMS256.txt. Bump the
 * version and every sum together.
 */
export const NODE = {
  version: '24.21.0',
  sha256: {
    'darwin-arm64': '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
    'darwin-x64': '0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299',
    'linux-arm64': '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
    'linux-x64': 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
    // node-v…-win-x64.zip
    'win32-x64': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  } as Record<string, string>,
}

/** Where Gui keeps its Node.js: one folder per version, of which only the pinned one stays. */
export const nodeRoot = () => join(app.getPath('userData'), 'runtimes', 'node')

/**
 * The folder with Gui's `node`, `npm` and `npx`, installed or not: `bin` in the Mac and
 * Linux builds, the top folder in the Windows one (`node.exe`, `npm.cmd`, `npx.cmd`).
 */
export const nodeBinDir = () =>
  IS_WINDOWS ? join(nodeRoot(), NODE.version) : join(nodeRoot(), NODE.version, 'bin')

/** Gui's `node`, installed or not. */
export const nodeExecutable = () => join(nodeBinDir(), IS_WINDOWS ? 'node.exe' : 'node')
