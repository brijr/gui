import { create } from 'zustand'
import type { Proposal, ProposalPull, ShipDraft } from '../../../shared/types'
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

interface ProposalStore {
  proposal: Proposal | null
  busy: Action | null
  error: string | null
  /** The review sheet has taken over the transcript */
  reviewing: boolean
  /** Comments the user has sent to the agent or put aside, by pull request URL */
  handled: Record<string, string[]>
  /** The commit the agent proposed (source_control_propose), for the bar's button to use */
  draft: ShipDraft | null
  /** Pushed, and the pull request is finished on the host's website at this page */
  finish: string | null
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
  reviewing: false,
  handled: loadHandled(),
  draft: null,
  finish: null,
}))

/** Bumped per read, so a slow one can't overwrite a newer answer. */
let reads = 0

export async function refreshProposal(fromRemote = false) {
  const current = ++reads
  const proposal = await gui.getProposal(fromRemote).catch(() => null)
  if (current !== reads) return
  // Nothing left to commit or push: the agent's proposal was for work that's gone.
  const settled = !proposal || (proposal.changes === 0 && proposal.ahead === 0)
  useProposal.setState(settled ? { proposal, draft: null } : { proposal })
}

/** The agent proposed a commit: the bar's button commits with its message. */
export function proposeDraft(draft: ShipDraft) {
  useProposal.setState({ draft })
  void refreshProposal()
}

export async function act(action: Action, run: () => Promise<void>) {
  if (useProposal.getState().busy) return
  useProposal.setState({ busy: action, error: null })
  try {
    await run()
  } catch (error) {
    useProposal.setState({ error: readableError(error) })
  } finally {
    useProposal.setState({ busy: null })
    await refreshProposal()
  }
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
