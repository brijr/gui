import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { RecentProject } from '../shared/types'
import { writeFileAtomic } from './atomic-file'
import { lastMessage } from './history'
import { loadWorktrees } from './worktree-registry'

const MAX_RECENT = 12
const file = () => join(app.getPath('userData'), 'recent-projects.json')
let pendingWrite: Promise<unknown> = Promise.resolve()

function updateRecent(update: (recent: RecentProject[]) => RecentProject[]) {
  const task = pendingWrite.then(async () => {
    const next = update(await loadRecent())
    await writeFileAtomic(file(), JSON.stringify(next, null, 2))
    return next
  })
  pendingWrite = task.catch(() => undefined)
  return task
}

export async function loadRecent(): Promise<RecentProject[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    return Array.isArray(parsed) ? (parsed as RecentProject[]) : []
  } catch {
    return []
  }
}

/** The last list `withChats` made: a new tab starts with it, then reads it again. */
let lastWithChats: RecentProject[] | null = null

export const recentSoFar = () => lastWithChats

/**
 * The list with each project's last message, for the start screen's recent chats, and for a
 * worktree Gui made, what it's a worktree of.
 */
export async function withChats(recent: RecentProject[]): Promise<RecentProject[]> {
  const worktrees = new Map((await loadWorktrees()).map((record) => [record.path, record]))
  lastWithChats = await Promise.all(
    recent.slice(0, MAX_RECENT).map(async (project) => {
      const record = worktrees.get(project.root)
      return {
        ...project,
        chat: await lastMessage(project.root),
        worktree: record ? { of: basename(record.main), branch: record.branch } : null,
      }
    }),
  )
  return lastWithChats
}

export async function clearRecent() {
  await updateRecent(() => [])
  lastWithChats = []
  app.clearRecentDocuments()
}

export async function removeRecent(root: string) {
  const next = await updateRecent((recent) => recent.filter((project) => project.root !== root))
  app.clearRecentDocuments()
  for (const project of next.toReversed()) app.addRecentDocument(project.root)
  return next
}

export async function addRecent(project: Omit<RecentProject, 'openedAt'>) {
  const next = await updateRecent((recent) =>
    [
      { root: project.root, name: project.name, openedAt: Date.now() },
      ...recent.filter((p) => p.root !== project.root),
    ].slice(0, MAX_RECENT),
  )
  app.addRecentDocument(project.root)
  return next
}
