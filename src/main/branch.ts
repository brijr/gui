import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { BranchStatus } from '../shared/types'

/**
 * The branch the toolbar shows, read from Git's HEAD file; null outside a repository.
 * Reads files only, never runs Git: Git can run the project's own code (hooks, fsmonitor),
 * and this is read as a project opens, before anything is trusted.
 */
export async function branchStatus(root: string): Promise<BranchStatus | null> {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    const info = await lstat(dotGit).catch(() => null)
    if (info) return readBranch(dir, dotGit, info.isFile())
    if (dirname(dir) === dir) return null
  }
}

async function readBranch(top: string, dotGit: string, linked: boolean) {
  let gitDir = dotGit
  // `.git` is a file in a linked worktree or a submodule: it points at the real one.
  if (linked) {
    const pointer = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''))
    if (!pointer?.[1]) return null
    gitDir = resolve(top, pointer[1].trim())
  }
  const head = (await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => null))?.trim()
  if (!head) return null
  return { branch: /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null }
}
