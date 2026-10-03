import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { RecentProject } from '../shared/types'

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

export async function addRecent(project: Omit<RecentProject, 'openedAt'>) {
  const recent = (await loadRecent()).filter((p) => p.root !== project.root)
  recent.unshift({ ...project, openedAt: Date.now() })
  const next = recent.slice(0, MAX_RECENT)
  await writeFile(file(), JSON.stringify(next, null, 2))
  app.addRecentDocument(project.root)
  return next
}
