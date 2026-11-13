import { randomBytes } from 'node:crypto'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, clipboard } from 'electron'
import { outsideSetup } from '../shared/outside-setup'
import type { OutsideAgentsState, OutsideClient } from '../shared/types'
import { mustSignIn } from './account'
import { writeFileAtomic } from './atomic-file'
import {
  OUTSIDE_MCP_PORT,
  type OutsideTarget,
  type RunningOutsideServer,
  startOutsideMcpServer,
} from './outside-mcp'
import { getPrefs, setPrefs } from './prefs'
import { lastFocusedWindow } from './window'

// "Let other agents use Gui" (Settings → Agents): Gui's tools for agents the user runs outside
// Gui, on a fixed loopback port (outside-mcp.ts), only while the setting is on. The token is a
// file in Gui's data folder, owner-only, kept across launches so the setup the user pasted
// keeps working; a new one replaces it. Not the Keychain, which would ask the user for access.

const tokenFile = () => join(app.getPath('userData'), 'outside-agents-token')

/**
 * The port, fixed. An unpackaged build started with GUI_E2E_OUTSIDE_MCP_PORT uses that one
 * instead, so a test doesn't meet the user's own Gui on it.
 */
function port() {
  const override = Number(process.env.GUI_E2E_OUTSIDE_MCP_PORT)
  return !app.isPackaged && Number.isInteger(override) && override > 0 ? override : OUTSIDE_MCP_PORT
}

let token: string | null = null
let server: RunningOutsideServer | null = null
/** Why the server isn't listening while the setting is on (the port is taken) */
let error: string | null = null
/** Starting and stopping happen one at a time, in the order asked. */
let queue: Promise<void> = Promise.resolve()
let onChange: () => void = () => {}

async function readToken(): Promise<string | null> {
  try {
    const saved = (await readFile(tokenFile(), 'utf8')).trim()
    return /^[0-9a-f]{64}$/.test(saved) ? saved : null
  } catch {
    return null
  }
}

async function makeToken(): Promise<string> {
  const fresh = randomBytes(32).toString('hex')
  await writeFileAtomic(tokenFile(), fresh)
  // writeFileAtomic makes it owner-only; this keeps it so if the file was there before.
  await chmod(tokenFile(), 0o600)
  token = fresh
  return fresh
}

/** The opening in the focused Gui window (or the one focused last), as a call comes in. */
function focusedTarget(): OutsideTarget | null {
  return lastFocusedWindow()?.activeTab.outsideTarget() ?? null
}

/** Starts or stops the server to match the setting. */
function sync() {
  queue = queue.then(async () => {
    const on = getPrefs().outsideAgents
    if (!on) {
      server?.close()
      server = null
      error = null
      return
    }
    if (server) return
    try {
      token = (await readToken()) ?? (await makeToken())
      server = await startOutsideMcpServer({
        port: port(),
        token: () => token,
        signedIn: () => !mustSignIn(),
        target: focusedTarget,
      })
      error = null
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code
      error =
        code === 'EADDRINUSE'
          ? `Another app is using port ${port()}, so other agents can’t reach Gui. Quit it, then turn this off and on again.`
          : `Gui couldn’t start listening: ${(failure as Error).message}`
      console.error('[gui] outside MCP server failed to start', failure)
    }
  })
  return queue.finally(() => onChange())
}

/** At launch: listens if the setting is on. `changed` refreshes Settings as its state changes. */
export function startOutsideAgents(changed: () => void) {
  onChange = changed
  void sync()
}

export function setOutsideAgents(on: boolean) {
  setPrefs({ outsideAgents: on })
  return sync()
}

/** A new token: setups with the old one stop working at once. */
export async function newOutsideToken() {
  if (!getPrefs().outsideAgents) return
  await makeToken()
  onChange()
}

/** Puts `client`'s setup, with the token, on the clipboard. The token never goes to a page. */
export async function copyOutsideSetup(client: OutsideClient) {
  if (!getPrefs().outsideAgents) return
  const current = token ?? (await readToken()) ?? (await makeToken())
  clipboard.writeText(outsideSetup(client, port(), current))
}

export function outsideAgentsState(): OutsideAgentsState {
  return { on: getPrefs().outsideAgents, port: port(), error }
}

/** At quit. */
export function stopOutsideAgents() {
  server?.close()
  server = null
}
