import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import type { AgentBinaries, AgentBinary } from '../../scripts/agent-binaries'
import type { AgentHealth, AgentId } from '../../src/shared/types'
import { electronExecutable, REPO_ROOT, waitFor } from './env'
import { killAll, pidsInDirectory } from './processes'
import { closeApp } from './session'
import { test as base } from './test'

export { expect } from './test'

/**
 * Far above any real release, so neither a CLI the developer has installed nor one in
 * node_modules can pass for the pinned version.
 */
const CLI_VERSION = '99.0.0'
const CLI_OUTPUT = `codex-cli ${CLI_VERSION}`
const FAKE_CLI = `#!/bin/sh\necho "${CLI_OUTPUT}"\n`
/** Where the manifest says a development copy lives; nothing is ever there. */
const NOWHERE = '@gui-e2e/not-installed'
const AGENT: AgentId = 'codex'

/** The two Macs the real manifest covers; the app picks its own key from platform and arch. */
const PLATFORMS = [
  { key: 'darwin-arm64', triple: 'aarch64-apple-darwin' },
  { key: 'darwin-x64', triple: 'x86_64-apple-darwin' },
]

// Shaped like the real codex entry: one npm package, a per-platform version suffix.
const versionFor = (platformKey: string) => `${CLI_VERSION}-${platformKey}`
const routeFor = (platformKey: string) => `/@openai/codex/-/codex-${versionFor(platformKey)}.tgz`

const integrityOf = (data: Buffer | string) =>
  `sha512-${createHash('sha512').update(data).digest('base64')}`

/**
 * A manifest where nothing on the machine can satisfy either agent, so both show up as
 * missing. Claude is pinned to nothing too: a real one would start the real Claude Code
 * (and its network access) every time the app launches.
 */
function manifestFor(integrity: string): AgentBinaries {
  const claude: Record<string, AgentBinary> = {}
  const codex: Record<string, AgentBinary> = {}
  for (const { key, triple } of PLATFORMS) {
    claude[key] = {
      package: `@anthropic-ai/claude-agent-sdk-${key}`,
      version: CLI_VERSION,
      integrity,
      bin: 'claude',
      devDir: NOWHERE,
      cliVersion: CLI_VERSION,
      minCliVersion: CLI_VERSION,
    }
    codex[key] = {
      package: '@openai/codex',
      version: versionFor(key),
      integrity,
      bin: `vendor/${triple}/bin/codex`,
      devDir: NOWHERE,
      cliVersion: CLI_VERSION,
      minCliVersion: CLI_VERSION,
    }
  }
  return { claude, codex }
}

/** An npm-style tarball whose CLI is a shell script that prints a version. */
function buildFakePackage(dir: string): { tarball: Buffer; integrity: string } {
  const root = join(dir, 'package')
  for (const { triple } of PLATFORMS) {
    const bin = join(root, 'vendor', triple, 'bin')
    mkdirSync(bin, { recursive: true })
    const file = join(bin, 'codex')
    writeFileSync(file, FAKE_CLI)
    chmodSync(file, 0o755)
  }
  const manifest = { name: '@openai/codex', version: CLI_VERSION }
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  const archive = join(dir, 'fake-codex.tgz')
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', dir, 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const tarball = readFileSync(archive)
  return { tarball, integrity: integrityOf(tarball) }
}

interface Registry {
  url: string
  /** Every request path received, in order. */
  requests: string[]
  close(): Promise<void>
}

/** A stand-in for registry.npmjs.org on 127.0.0.1: the tarball, or a 404 for everything. */
async function startRegistry(tarball: Buffer | null): Promise<Registry> {
  const requests: string[] = []
  const routes = new Set(PLATFORMS.map(({ key }) => routeFor(key)))
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    if (tarball && routes.has(path)) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': tarball.length,
      })
      response.end(tarball)
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The test registry has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // fetch keeps its connection alive; close() alone would wait for it to time out.
        server.closeAllConnections()
      }),
  }
}

function launchEnv(manifest: string, registry: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Either would stop Electron from behaving like the app a user launches.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key]
  return {
    ...env,
    // Always explicit, so a value in the caller's shell can't open a project.
    GUI_OPEN: '',
    GUI_AGENT_MANIFEST: manifest,
    GUI_AGENT_REGISTRY: registry,
  }
}

interface HistoryStore {
  guiAgentHistory?: AgentHealth[]
}

export interface InstallOptions {
  /** `serves-package`: the registry has the tarball. `not-found`: every request gets a 404. */
  registry: 'serves-package' | 'not-found'
  /** `differs`: the manifest pins a checksum that is not the served tarball's. */
  checksum?: 'matches' | 'differs'
}

/** Gui running with no project, a fake codex pinned in its manifest, and a local registry. */
export interface InstallHarness {
  /** Request paths the local registry received. */
  requests: string[]
  /** The one path a correct download asks the registry for. */
  route: string
  /** Bytes in the tarball the registry serves. */
  tarballSize: number
  /** The pinned package version, which names the folder under `agents/codex`. */
  version: string
  /** Where a successful install puts the CLI. */
  binaryPath: string
  /** The CLI version the manifest pins, which the app reports for a CLI it installed. */
  cliVersion: string
  /** What the fake CLI prints for `--version`. */
  cliOutput: string
  /** Names inside `<userData>/agents/codex`, hidden files included; empty if there is none. */
  installedEntries(): string[]
  /** Waits for codex's health to satisfy `until` and returns it. */
  waitForCodex(
    until: (health: AgentHealth) => boolean,
    label: string,
    timeout?: number,
  ): Promise<AgentHealth>
  /**
   * Presses "Install" for codex: starts recording every health update the window receives,
   * then calls `installAgent` without waiting. The outcome arrives through the window state.
   */
  install(): Promise<void>
  /** Codex's health as pushed to the window since `install()`. */
  history(): Promise<AgentHealth[]>
}

interface Fixtures {
  /** Starts a fresh app (own `--user-data-dir`), registry and temp dir; all removed afterwards. */
  launchInstall: (options: InstallOptions) => Promise<InstallHarness>
}

export const test = base.extend<Fixtures>({
  launchInstall: async ({ keepTemp }, use, testInfo) => {
    const cleanups: Array<() => Promise<void> | void> = []
    const diagnostics: Array<() => Promise<void>> = []

    await use(async (options) => {
      const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'gui-e2e-install-'))
      cleanups.push(() => {
        if (keepTemp) console.log(`[e2e] kept ${scratch}`)
        else rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
      })
      const userData = join(scratch, 'user-data')
      mkdirSync(userData)

      const pack = buildFakePackage(join(scratch, 'fake-package'))
      const integrity =
        options.checksum === 'differs' ? integrityOf('not the tarball') : pack.integrity
      const manifestPath = join(scratch, 'manifest.json')
      writeFileSync(manifestPath, JSON.stringify(manifestFor(integrity)))

      const served = options.registry === 'serves-package' ? pack.tarball : null
      const registry = await startRegistry(served)
      cleanups.push(() => registry.close())

      const app = await electron.launch({
        executablePath: electronExecutable(),
        args: [REPO_ROOT, `--user-data-dir=${userData}`],
        env: launchEnv(manifestPath, registry.url),
        timeout: 60_000,
      })
      const output: string[] = []
      const collect = (chunk: Buffer) => {
        output.push(chunk.toString())
      }
      app.process().stdout?.on('data', collect)
      app.process().stderr?.on('data', collect)
      cleanups.push(async () => {
        await closeApp(app)
        // The health check runs an agent process in the profile folder; none may outlive the test.
        killAll(pidsInDirectory(userData))
      })

      const chrome = await findChromePage(app)
      await chrome.waitForFunction(() => 'gui' in window)

      const key = await app.evaluate(() => `${process.platform}-${process.arch}`)
      const platform = PLATFORMS.find((entry) => entry.key === key)
      if (!platform) throw new Error(`The fake codex package has no build for ${key}`)
      const version = versionFor(platform.key)
      const codexDir = join(userData, 'agents', 'codex')

      const codex = async () => {
        const state = await chrome.evaluate(() => window.gui.getState())
        const health = state.agents.find((agent) => agent.id === AGENT)
        if (!health) throw new Error('The window state has no codex entry')
        return health
      }

      diagnostics.push(async () => {
        const health = await codex().catch(() => null)
        const history = await readHistory(chrome).catch(() => [])
        const attach = (name: string, body: string) =>
          testInfo.attach(name, { body: body || '(empty)', contentType: 'text/plain' })
        await attach('app-output.log', output.join(''))
        await attach('codex-health.json', JSON.stringify(health, null, 2))
        await attach('codex-health-history.json', JSON.stringify(history, null, 2))
        await attach('registry-requests.json', JSON.stringify(registry.requests, null, 2))
      })

      return {
        requests: registry.requests,
        route: routeFor(platform.key),
        tarballSize: pack.tarball.length,
        version,
        binaryPath: join(codexDir, version, 'package', 'vendor', platform.triple, 'bin', 'codex'),
        cliVersion: CLI_VERSION,
        cliOutput: CLI_OUTPUT,
        installedEntries: () => (existsSync(codexDir) ? readdirSync(codexDir).sort() : []),
        waitForCodex: (until, label, timeout = 60_000) =>
          waitFor(
            async () => {
              const health = await codex()
              return until(health) ? health : null
            },
            label,
            { timeout },
          ),
        install: async () => {
          await chrome.evaluate((id) => {
            const store = globalThis as unknown as HistoryStore
            const history: AgentHealth[] = []
            store.guiAgentHistory = history
            window.gui.onState((state) => {
              const health = state.agents.find((agent) => agent.id === id)
              if (health) history.push(health)
            })
            void window.gui.installAgent(id)
          }, AGENT)
        },
        history: () => readHistory(chrome),
      }
    })

    const failed = testInfo.status !== testInfo.expectedStatus
    if (failed) {
      for (const collect of diagnostics) await collect().catch(() => undefined)
    }
    const problems: string[] = []
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (problems.length > 0) throw new Error(problems.join('\n'))
  },
})

function findChromePage(app: ElectronApplication): Promise<Page> {
  const find = () =>
    app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/index.html'))
  return waitFor(find, 'the app window', { timeout: 45_000 })
}

function readHistory(chrome: Page): Promise<AgentHealth[]> {
  return chrome.evaluate(() => {
    const store = globalThis as unknown as HistoryStore
    return store.guiAgentHistory ?? []
  })
}
