import { create } from 'zustand'
import type {
  SourceControlAction,
  SourceControlRequest,
  SourceControlResult,
} from '../../../shared/source-control'
import type { ShipDraft, ShipInfo, ShipRequest, ShipResult } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { refreshProposal } from './proposal-state'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'blocked'; message: string }
  | { kind: 'ready'; info: ShipInfo }

interface ShipSheetStore {
  open: boolean
  loaded: Loaded
  draft: ShipRequest | null
  proposed: ShipDraft | null
  busy: boolean
  action: SourceControlRequest['kind'] | null
  error: string | null
  notice: string | null
  createOpen: boolean
  /** The branch picker is open */
  pickerOpen: boolean
  /** The new-worktree dialog is open */
  worktreeOpen: boolean
  reviewDraft: { title: string; body: string } | null
  pendingProposal: ShipDraft | null
  edited: boolean
  root: string | null
}
const CLOSED: ShipSheetStore = {
  open: false,
  loaded: { kind: 'loading' },
  draft: null,
  proposed: null,
  busy: false,
  action: null,
  error: null,
  notice: null,
  createOpen: false,
  pickerOpen: false,
  worktreeOpen: false,
  reviewDraft: null,
  pendingProposal: null,
  edited: false,
  root: null,
}
export const useShipSheet = create<ShipSheetStore>(() => CLOSED)
let generation = 0
let reads = 0

export function toggleShipSheet() {
  const { open, busy } = useShipSheet.getState()
  if (busy) return
  generation++
  useShipSheet.setState(open ? CLOSED : { ...CLOSED, open: true })
}
export function openShipSheet(proposed: ShipDraft) {
  const state = useShipSheet.getState()
  if (state.busy || (state.open && state.edited)) {
    useShipSheet.setState({ pendingProposal: proposed })
    return
  }
  generation++
  useShipSheet.setState({ ...CLOSED, open: true, proposed })
}
/**
 * Opens Source Control (left open if it is), from the toolbar's branch menu: as it is, or
 * with the branch picker or the new-branch or new-worktree dialog open over it.
 */
export function showSourceControl(
  with_: 'sourceControl' | 'switchBranch' | 'newBranch' | 'newWorktree' = 'sourceControl',
) {
  const state = useShipSheet.getState()
  if (state.busy) return
  if (!state.open) {
    generation++
    useShipSheet.setState({ ...CLOSED, open: true })
  }
  useShipSheet.setState({
    pickerOpen: with_ === 'switchBranch',
    createOpen: with_ === 'newBranch',
    worktreeOpen: with_ === 'newWorktree',
    error: null,
  })
}
export function setPickerOpen(pickerOpen: boolean) {
  useShipSheet.setState({ pickerOpen })
}
export function setWorktreeOpen(worktreeOpen: boolean) {
  useShipSheet.setState({ worktreeOpen, error: null })
}
export function closeShipSheet() {
  if (useShipSheet.getState().busy) return
  generation++
  useShipSheet.setState(CLOSED)
}

/** Refresh status without overwriting typing or including newly discovered files. */
export async function loadShipInfo() {
  const current = generation
  const read = ++reads
  let loaded: Loaded
  try {
    const info = await gui.getShipInfo()
    if (!info) loaded = { kind: 'blocked', message: 'Open a project first.' }
    else if (info.blocked) loaded = { kind: 'blocked', message: info.blocked }
    else loaded = { kind: 'ready', info }
  } catch (error) {
    loaded = { kind: 'blocked', message: readableError(error) }
  }
  if (current !== generation || read !== reads) return
  const previous = useShipSheet.getState()
  if (loaded.kind === 'ready' && previous.root && previous.root !== loaded.info.workspace?.root) {
    generation++
    useShipSheet.setState({ ...CLOSED, open: previous.open })
  }
  useShipSheet.setState(({ draft, proposed, loaded: before }) => {
    if (loaded.kind !== 'ready') return { loaded }
    const info = loaded.info
    const paths = new Set(info.files.map((file) => file.path))
    if (!draft)
      return {
        loaded,
        root: info.workspace?.root ?? null,
        draft: {
          ...info.suggestion,
          mode: proposed?.mode ?? 'commit',
          branch: proposed?.branch?.trim() || info.branch || info.suggestion.branch,
          title: proposed?.title.trim() || info.suggestion.title,
          body: proposed?.body.trim() ?? info.suggestion.body,
          files:
            proposed?.files === undefined
              ? [...paths]
              : proposed.files.filter((path) => paths.has(path)),
        },
        error: proposed?.files?.some((path) => !paths.has(path))
          ? 'Some proposed files are no longer changed. Review the selection before committing.'
          : null,
      }
    const changedBranch = before.kind === 'ready' && before.info.branch !== info.branch
    return {
      loaded,
      root: info.workspace?.root ?? null,
      draft: {
        ...draft,
        branch: changedBranch ? (info.branch ?? info.suggestion.branch) : draft.branch,
        files: changedBranch ? [] : (draft.files ?? []).filter((path) => paths.has(path)),
      },
    }
  })
}
export function setShipDraft(patch: Partial<ShipRequest>) {
  useShipSheet.setState(({ draft }) =>
    draft ? { draft: { ...draft, ...patch }, edited: true } : {},
  )
}
export function acceptShipProposal() {
  const { pendingProposal, busy } = useShipSheet.getState()
  if (!pendingProposal || busy) return
  generation++
  useShipSheet.setState({
    draft: null,
    proposed: pendingProposal,
    pendingProposal: null,
    edited: false,
    error: null,
    notice: null,
  })
  void loadShipInfo()
}
export function setCreateBranchOpen(createOpen: boolean) {
  useShipSheet.setState({ createOpen, error: null })
}

/** Main owns validation, operation locks, and confirmation of a shared-branch push. */
export async function performSourceControl(action: SourceControlAction) {
  const state = useShipSheet.getState()
  if (state.busy || state.loaded.kind !== 'ready' || !state.loaded.info.workspace) return
  const expected = state.loaded.info.workspace
  const current = generation
  useShipSheet.setState({ busy: true, action: action.kind, error: null, notice: null })
  try {
    const result = await gui.sourceControl({ ...action, expected })
    if (current !== generation) return
    applyResult(result, state.draft)
    if ((result.outcome === 'created' || result.outcome === 'compare') && result.url)
      openExternal(result.url)
  } catch (error) {
    if (current === generation) useShipSheet.setState({ error: readableError(error) })
  } finally {
    if (current === generation) {
      await loadShipInfo()
      useShipSheet.setState({ busy: false, action: null })
      void refreshProposal()
    }
  }
}
function applyResult(result: SourceControlResult, before: ShipRequest | null) {
  if (result.outcome === 'branch-required') {
    useShipSheet.setState({ createOpen: true })
    return
  }
  if (result.outcome === 'cancelled') {
    useShipSheet.setState({ notice: 'Push cancelled.' })
    return
  }
  if (result.outcome === 'switched' || result.outcome === 'created-branch') {
    useShipSheet.setState(({ draft }) => ({
      createOpen: false,
      proposed: null,
      draft: draft ? { ...draft, branch: result.branch ?? '', files: [] } : null,
      notice: `${result.outcome === 'switched' ? 'Switched to' : 'Created'} ${result.branch}.`,
    }))
  } else if (result.outcome === 'committed') {
    useShipSheet.setState(({ draft }) => ({
      draft: draft ? { ...draft, title: '', body: '', files: [] } : null,
      proposed: null,
      reviewDraft: before ? { title: before.title, body: before.body } : null,
      notice: `Commit saved · ${result.commit} on ${result.branch}.`,
    }))
  } else if (result.outcome === 'pushed') {
    useShipSheet.setState({
      notice: `Pushed saved commits from ${result.branch}. Uncommitted edits stay here.`,
    })
  } else {
    useShipSheet.setState({
      notice: `Pull request ${result.outcome === 'created' ? 'created' : 'ready to finish in your browser'}.`,
      draft: before,
    })
  }
}
export async function submitShip(info: ShipInfo) {
  const { draft } = useShipSheet.getState()
  if (!draft || !info.workspace) return
  return performSourceControl({
    kind: 'commit',
    files: draft.files ?? [],
    title: draft.title,
    body: draft.body,
  })
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
