import { create } from 'zustand'
import type { Proposal, ProposalPull, ShipDraft, ShipResult } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'

export type Action =
  | 'fresh'
  | 'bringIn'
  | 'finish'
  | 'cancel'
  | 'resolve'
  | 'removeWorktree'
  | 'share'
  | 'stay'
  | 'trust'

/** What the bar says after sharing, until the next change: a line, and a page to open. */
export interface ShareDone {
  text: string
  /** The host's page to finish the pull request on; the strip's Open button */
  url: string | null
  /** Uncommitted changes when it was said; more than that is the next change, which clears it */
  changes: number | null
}

interface ProposalStore {
  proposal: Proposal | null
  busy: Action | null
  error: string | null
  /** Runs the action that failed again, for the error's own button (Add name and email…) */
  retry: (() => void) | null
  /** The review sheet has taken over the transcript */
  reviewing: boolean
  /** Comments the user has sent to the agent or put aside, by pull request URL */
  handled: Record<string, string[]>
  /** The commit the agent proposed (source_control_propose), for the bar's button to use */
  draft: ShipDraft | null
  /** Shared: what happened, until the next change */
  done: ShareDone | null
}

const HANDLED_KEY = 'gui.reviewHandled'

function loadHandled(): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export const useProposal = create<ProposalStore>(() => ({
  proposal: null,
  busy: null,
  error: null,
  retry: null,
  reviewing: false,
  handled: loadHandled(),
  draft: null,
  done: null,
}))

/** Bumped per read, so a slow one can't overwrite a newer answer. */
let reads = 0

export async function refreshProposal(fromRemote = false) {
  const current = ++reads
  const proposal = await gui.getProposal(fromRemote).catch(() => null)
  if (current !== reads) return
  // Nothing left to commit or push: the agent's proposal was for work that's gone.
  const settled = !proposal || (proposal.changes === 0 && proposal.ahead === 0)
  const { done } = useProposal.getState()
  useProposal.setState({
    proposal,
    ...(settled ? { draft: null } : {}),
    ...(done && proposal ? { done: nextDone(done, proposal) } : {}),
  })
}

/** The first read after sharing sets where the changes stood; the next change clears it. */
function nextDone(done: ShareDone, proposal: Proposal): ShareDone | null {
  if (done.changes === null) return { ...done, changes: proposal.changes }
  return proposal.changes > done.changes ? null : done
}

/** The agent proposed a commit: the bar's button commits with its message. */
export function proposeDraft(draft: ShipDraft) {
  useProposal.setState({ draft })
  void refreshProposal()
}

export async function act(action: Action, run: () => Promise<void>) {
  if (useProposal.getState().busy) return
  useProposal.setState({ busy: action, error: null, retry: null })
  try {
    await run()
  } catch (error) {
    useProposal.setState({
      error: readableError(error),
      retry: () => void act(action, run),
    })
  } finally {
    useProposal.setState({ busy: null })
    await refreshProposal()
  }
}

/** Host names as the bar says them; null for one Gui can't name. */
const HOSTS: Record<NonNullable<Proposal['remote']>, string | null> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  other: null,
}

/**
 * The bar's button, and Source Control's Create pull request: commits, pushes and creates the
 * pull request (ship.ts), then says what happened. A pull request page the host doesn't open
 * by itself waits behind the strip's Open button.
 */
export async function share(run: () => Promise<ShipResult>) {
  const result = await run()
  const { proposal } = useProposal.getState()
  useProposal.setState({ draft: null, done: doneFor(result, proposal) })
  if (result.url && opensByItself(result)) openExternal(result.url)
  return result
}

function doneFor(result: ShipResult, proposal: Proposal | null): ShareDone | null {
  const host = proposal?.remote ? HOSTS[proposal.remote] : null
  const said = (text: string, url: string | null = null) => ({ text, url, changes: null })
  switch (result.outcome) {
    case 'committed':
      return said(`Committed on ${result.branch}. It stays on this Mac until you push.`)
    case 'pushed':
      return said(`Pushed ${result.branch}${host ? ` to ${host}` : ''}.`)
    case 'compare': {
      if (!result.url || opensByItself(result)) return null
      const site = linkTarget(result.url)?.host ?? 'the website'
      return said(`Pushed. Create the pull request on ${site} to finish.`, result.url)
    }
    // A created pull request shows as the bar itself; cancelled is nothing at all.
    default:
      return null
  }
}

/** The chat window hands window.open to the system browser (guardAppContents in window.ts). */
export function openExternal(url: string) {
  if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener')
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

export function markHandled(pull: ProposalPull, ids: string[]) {
  useProposal.setState(({ handled }) => {
    const next = {
      ...handled,
      [pull.url]: [...new Set([...(handled[pull.url] ?? []), ...ids])],
    }
    try {
      localStorage.setItem(HANDLED_KEY, JSON.stringify(next))
    } catch {
      // Remembering is a convenience; the comments just show again next time.
    }
    return { handled: next }
  })
}

export function openReview(open: boolean) {
  useProposal.setState({ reviewing: open, error: null })
}
