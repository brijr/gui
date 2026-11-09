import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, constants, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { NodeSetup, PackageManager } from '../shared/types'
import { download } from './download'
import { describeError } from './errors'
import { findExecutable } from './executables'
import { NODE, nodeBinDir, nodeRoot } from './node-paths'
import { execFile } from './process'
import { addToPath, getShellEnv } from './shell-env'

/** Download progress is pushed to every window; a 30 MB download has thousands of chunks. */
const PROGRESS_INTERVAL_MS = 150

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  )

/**
 * Node.js for Macs that have none, so designers can run apps without installing developer
 * tools: Gui downloads the official build (node-paths.ts), checks it against its pinned
 * SHA-256, and unpacks it into its own data folder. Its `bin` goes at the end of the PATH
 * everything Gui starts gets; nothing outside Gui changes, and a user's own Node wins.
 */
class NodeRuntime extends EventEmitter<{ change: [setup: NodeSetup] }> {
  private setup: NodeSetup = { status: 'missing', progress: null, error: null }
  private installing: Promise<void> | null = null
  private download: AbortController | null = null
  private lastProgress = 0

  constructor() {
    super()
    // Every tab waiting on it listens.
    this.setMaxListeners(0)
  }

  get state() {
    return this.setup
  }

  /**
   * Whether a project needs Node.js that this Mac doesn't have: anything but Bun, which
   * stands in for `node` itself, needs `node` on the PATH (the user's, or Gui's once installed).
   */
  async missingFor(packageManager: PackageManager) {
    if (packageManager === 'bun') return false
    const env = await getShellEnv()
    return (await findExecutable('node', env.PATH)) === null
  }

  /** Downloads and unpacks Gui's Node.js; one at a time, a second call joins the first. */
  install() {
    this.installing ??= this.run().finally(() => {
      this.installing = null
    })
    return this.installing
  }

  /** Stops a download in progress (Gui is quitting). */
  dispose() {
    this.download?.abort()
  }

  private async run() {
    const platform = `${process.platform}-${process.arch}`
    const sha256 = NODE.sha256[platform]
    if (!sha256) {
      this.set({ status: 'failed', progress: null, error: "Gui can't set up Node.js on this Mac." })
      return
    }
    const root = nodeRoot()
    const name = `node-v${NODE.version}-${platform}`
    const tag = randomBytes(6).toString('hex')
    const archive = join(root, `.download-${tag}.tar.xz`)
    const staging = join(root, `.unpack-${tag}`)
    const controller = new AbortController()
    this.download = controller
    this.set({ status: 'installing', progress: { received: 0, total: null }, error: null })
    try {
      await mkdir(root, { recursive: true })
      // Leftovers from an install interrupted by a quit or crash.
      for (const entry of await readdir(root)) {
        if (entry.startsWith('.')) await rm(join(root, entry), { recursive: true, force: true })
      }
      const digest = await download(
        `https://nodejs.org/dist/v${NODE.version}/${name}.tar.xz`,
        archive,
        {
          what: 'Node.js',
          algorithm: 'sha256',
          encoding: 'hex',
          onProgress: (progress) => this.progress(progress),
          signal: controller.signal,
        },
      )
      if (digest !== sha256) {
        throw new Error(
          "The Node.js download didn't match its expected checksum, so Gui didn't install it.",
        )
      }
      this.set({ ...this.setup, progress: { received: 1, total: 1 } })
      await mkdir(staging)
      await new Promise<void>((resolve, reject) => {
        execFile(
          '/usr/bin/tar',
          ['-xJf', archive, '-C', staging, '--strip-components', '1'],
          (error) =>
            error ? reject(new Error(`Couldn't unpack Node.js: ${error.message}`)) : resolve(),
        )
      })
      for (const bin of ['node', 'npm', 'npx']) {
        if (!(await isExecutable(join(staging, 'bin', bin)))) {
          throw new Error(`The Node.js download doesn't contain ${bin}.`)
        }
      }
      const target = join(root, NODE.version)
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
      // Older versions Gui installed are no longer used.
      for (const entry of await readdir(root)) {
        if (entry !== NODE.version && !entry.startsWith('.')) {
          await rm(join(root, entry), { recursive: true, force: true })
        }
      }
      await addToPath(nodeBinDir())
      this.set({ status: 'ready', progress: null, error: null })
    } catch (error) {
      if (controller.signal.aborted) return
      const { message } = describeError(error)
      this.set({ status: 'failed', progress: null, error: message })
    } finally {
      this.download = null
      await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
  }

  private progress(progress: NonNullable<NodeSetup['progress']>) {
    const now = Date.now()
    const done = progress.total !== null && progress.received >= progress.total
    if (!done && now - this.lastProgress < PROGRESS_INTERVAL_MS) return
    this.lastProgress = now
    this.set({ ...this.setup, progress })
  }

  private set(setup: NodeSetup) {
    this.setup = setup
    this.emit('change', setup)
  }
}

export const nodeRuntime = new NodeRuntime()
