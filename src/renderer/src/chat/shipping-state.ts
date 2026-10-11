import { create } from 'zustand'
import type { ShipInfo, ShipRequest, ShipResult } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { useProposal } from './proposal-state'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'blocked'; message: string }
  | { kind: 'ready'; info: ShipInfo }

interface ShipSheetStore {
  open: boolean
  loaded: Loaded
  /** The form; lives here so it survives the panel remounting on dock/float/minimize */
  draft: ShipRequest | null
  busy: boolean
  error: string | null
  done: { result: ShipResult; info: ShipInfo } | null
}

const CLOSED: ShipSheetStore = {
  open: false,
  loaded: { kind: 'loading' },
  draft: null,
  busy: false,
  error: null,
  done: null,
}

export const useShipSheet = create<ShipSheetStore>(() => CLOSED)

/** Bumped on close so a slow load can't fill a sheet that was closed and reopened. */
let generation = 0

export function toggleShipSheet() {
  const { open, busy } = useShipSheet.getState()
  if (busy) return
  generation++
  useShipSheet.setState(open ? CLOSED : { ...CLOSED, open: true })
}

export function closeShipSheet() {
  if (useShipSheet.getState().busy) return
  generation++
  useShipSheet.setState(CLOSED)
}

/** Fetches what would be shipped; the draft is only filled from the suggestion once. */
export async function loadShipInfo() {
  const current = generation
  let loaded: Loaded
  try {
    const info = await gui.getShipInfo()
    if (!info) loaded = { kind: 'blocked', message: 'Open a project first.' }
    else if (info.blocked) loaded = { kind: 'blocked', message: info.blocked }
    else loaded = { kind: 'ready', info }
  } catch (error) {
    loaded = { kind: 'blocked', message: readableError(error) }
  }
  if (current !== generation) return
  useShipSheet.setState(({ draft }) => {
    if (loaded.kind !== 'ready') return { loaded }
    if (!draft) return { loaded, draft: suggestionFor(loaded.info) }
    // A failed push may have saved the selected files already. Keep other edits excluded
    // and allow retrying just the push, rather than accidentally committing those edits.
    const paths = new Set(loaded.info.files.map((file) => file.path))
    const files = draft.files?.filter((path) => paths.has(path))
    return { loaded, draft: { ...draft, files } }
  })
}

/**
 * Only pushing to a pull request that's already open (after bringing in the latest, say):
 * nothing gets committed, so its own title is the one to show.
 */
function suggestionFor(info: ShipInfo): ShipRequest {
  const pull = useProposal.getState().proposal?.pull
  const open = pull && (pull.state === 'open' || pull.state === 'draft')
  if (!open || info.files.length > 0 || info.suggestion.branch !== info.branch)
    return info.suggestion
  return { ...info.suggestion, title: pull.title, body: '' }
}

export function setShipDraft(patch: Partial<ShipRequest>) {
  useShipSheet.setState(({ draft }) => (draft ? { draft: { ...draft, ...patch } } : {}))
}

export async function submitShip(info: ShipInfo) {
  const { draft, busy } = useShipSheet.getState()
  if (!draft || busy) return
  const request = {
    mode: info.remote ? (draft.mode ?? 'share') : 'commit',
    files: draft.files,
    branch: draft.branch.trim(),
    title: draft.title.trim(),
    body: draft.body.trim(),
  }
  useShipSheet.setState({ busy: true, error: null })
  try {
    const result = await gui.ship(request)
    // The pull request isn't open until they finish it in the browser, so go there now.
    if (opensByItself(result) && result.url) openExternal(result.url)
    useShipSheet.setState({ busy: false, done: { result, info } })
  } catch (error) {
    useShipSheet.setState({ busy: false, error: readableError(error) })
    // A failed push still committed: refresh so the sheet says what's left to do.
    void loadShipInfo()
  }
}

/** The chat window hands window.open to the system browser (guardAppContents in window.ts). */
export function openExternal(url: string) {
  if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener')
}

/** Hosts whose pull request pages Gui builds itself. */
const KNOWN_HOSTS = new Map([
  ['github.com', 'GitHub'],
  ['gitlab.com', 'GitLab'],
])

/**
 * Where a result's link goes: its host as shown on the button, and the host's name when
 * it's github.com or gitlab.com over https. Exported for tests.
 */
export function linkTarget(url: string | null): { host: string; known: string | null } | null {
  if (!url) return null
  try {
    const { protocol, host, hostname } = new URL(url)
    if (protocol !== 'https:' && protocol !== 'http:') return null
    return { host, known: (protocol === 'https:' && KNOWN_HOSTS.get(hostname)) || null }
  } catch {
    return null
  }
}

/**
 * Only the new-pull-request page Gui built for github.com or gitlab.com opens without a
 * click. Any other link (a self-hosted server's, or one a server printed while pushing)
 * waits behind a button that names its host. Exported for tests.
 */
export function opensByItself(result: ShipResult): boolean {
  return result.outcome === 'compare' && Boolean(linkTarget(result.url)?.known)
}
