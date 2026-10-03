import { test as base, expect } from '@playwright/test'
import { waitFor } from './env'
import { createFixtureCopy, type FixtureCopy, removeFixtureCopy } from './fixtures'
import { devServerPids, killAll, pidsInDirectory } from './processes'
import { type GratSession, type LaunchOptions, launchGrat } from './session'

export { expect }

type Launch = (options: LaunchOptions) => Promise<GratSession>

interface Fixtures {
  /**
   * Copies a fixture into a temp dir (own git repo, own Electron profile), launches Grat on
   * it, and after the test quits the app and checks that no dev server outlived it.
   */
  launch: Launch
  /** Keep the temp directories after the test (GRAT_E2E_KEEP=1) to inspect a failure. */
  keepTemp: boolean
}

/** Waits for the dev server to be gone after quit; reports (and kills) anything left. */
async function checkShutdown(copy: FixtureCopy): Promise<string[]> {
  const problems: string[] = []
  let listeners = devServerPids(copy.root)
  if (listeners.length > 0) {
    // The app kills the dev server's process group on quit, so this normally settles at once.
    const gone = async () => devServerPids(copy.root).length === 0
    await waitFor(gone, 'dev server shutdown', { timeout: 15_000 }).catch(() => undefined)
    listeners = devServerPids(copy.root)
  }
  if (listeners.length > 0) {
    problems.push(`Dev server still listening after quit (pids ${listeners.join(', ')})`)
  }
  // Never leave anything running from the temp dir, whether or not it was a listener.
  killAll(pidsInDirectory(copy.root))
  return problems
}

export const test = base.extend<Fixtures>({
  keepTemp: [process.env.GRAT_E2E_KEEP === '1', { option: true }],

  launch: async ({ keepTemp }, use, testInfo) => {
    const copies: FixtureCopy[] = []
    const sessions: GratSession[] = []

    await use(async (options) => {
      const copy = createFixtureCopy(options.fixture)
      copies.push(copy)
      const session = await launchGrat(copy, options, testInfo)
      sessions.push(session)
      return session
    })

    const failed = testInfo.status !== testInfo.expectedStatus
    for (const session of sessions) {
      if (failed) await session.captureDiagnostics()
      await session.close()
    }

    const problems: string[] = []
    for (const copy of copies) {
      problems.push(...(await checkShutdown(copy)))
      if (keepTemp) console.log(`[e2e] kept ${copy.base}`)
      else removeFixtureCopy(copy)
    }
    if (problems.length > 0) throw new Error(problems.join('\n'))
  },
})
