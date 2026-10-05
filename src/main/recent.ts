import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { RecentProject } from '../shared/types'
import { lastMessage } from './history'

const MAX_RECENT = 12
const file = () => join(app.getPath('userData'), 'recent-projects.json')

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

/** The list with each project's last message, for the start screen's recent chats. */
export async function withChats(recent: RecentProject[]): Promise<RecentProject[]> {
  lastWithChats = await Promise.all(
    recent.map(async (project) => ({ ...project, chat: await lastMessage(project.root) })),
  )
  return lastWithChats
}

export async function clearRecent() {
  lastWithChats = []
  await writeFile(file(), '[]\n')
  app.clearRecentDocuments()
}

export async function addRecent(project: Omit<RecentProject, 'openedAt'>) {
  const recent = (await loadRecent()).filter((p) => p.root !== project.root)
  recent.unshift({ root: project.root, name: project.name, openedAt: Date.now() })
  const next = recent.slice(0, MAX_RECENT)
  await writeFile(file(), JSON.stringify(next, null, 2))
  app.addRecentDocument(project.root)
  return next
}
