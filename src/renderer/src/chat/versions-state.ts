import { create } from 'zustand'
import type { Version } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'

interface VersionsStore {
  open: boolean
  /** Newest first; null until the first load lands */
  versions: Version[] | null
  /** Why the list can't be shown (no project, checkpoints unreadable) */
  blocked: string | null
  /** `save` while saving, or the id of the version being restored */
  busy: string | null
  error: string | null
}

const CLOSED: VersionsStore = {
  open: false,
  versions: null,
  blocked: null,
  busy: null,
  error: null,
}

export const useVersions = create<VersionsStore>(() => CLOSED)

/** Bumped on close so a slow load can't fill a sheet that was closed and reopened. */
let generation = 0

export function toggleVersions() {
  const { open, busy } = useVersions.getState()
  if (busy) return
  generation++
  useVersions.setState(open ? CLOSED : { ...CLOSED, open: true })
}

export function closeVersions() {
  if (useVersions.getState().busy) return
  generation++
  useVersions.setState(CLOSED)
}

export async function loadVersions() {
  const current = generation
  let patch: Partial<VersionsStore>
  try {
    const versions = await gui.getVersions()
    patch = versions
      ? { versions, blocked: null }
      : { versions: null, blocked: 'Open a project first.' }
  } catch (error) {
    patch = { versions: null, blocked: readableError(error) }
  }
  if (current !== generation) return
  useVersions.setState(patch)
}

/** Saves the files as they are now; true when the version was made. */
export async function saveVersion(name: string): Promise<boolean> {
  if (useVersions.getState().busy) return false
  useVersions.setState({ busy: 'save', error: null })
  try {
    // The files are this version now (main just saved them): it leads the list as current.
    // Listing again would take a second snapshot, and any file touched in between would cost
    // it the mark.
    const saved = await gui.saveVersion(name)
    useVersions.setState(({ versions }) => ({
      busy: null,
      versions: [saved, ...(versions ?? []).map((version) => ({ ...version, current: false }))],
    }))
    return true
  } catch (error) {
    useVersions.setState({ busy: null, error: readableError(error) })
    return false
  }
}

export async function restoreVersion(id: string) {
  if (useVersions.getState().busy) return
  useVersions.setState({ busy: id, error: null })
  try {
    await gui.restoreVersion(id)
    useVersions.setState({ busy: null })
    // The restore saved how the files were first: the list gains that safety version.
    void loadVersions()
  } catch (error) {
    useVersions.setState({ busy: null, error: readableError(error) })
    void loadVersions()
  }
}
