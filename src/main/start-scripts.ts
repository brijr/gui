import { join } from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { readPackageJson } from './project'
import type { TrustedScripts } from './trust'

/** Package scripts an install runs from the project's own package.json. */
export const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

/** What starting the project runs, as one string: the command, its folder, and its script. */
export const startKey = (project: ProjectInfo) =>
  [project.devCommand ?? '', project.appDir ?? '', project.devScript ?? ''].join('\n')

/**
 * The install lifecycle scripts of the root and the app's folder, by "name" for the root's
 * and "folder: name" for the app's. An install in a workspace runs the app's too.
 */
export async function installScriptsOf(project: ProjectInfo): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  for (const dir of ['', ...(project.appDir ? [project.appDir] : [])]) {
    const scripts = (await readPackageJson(join(project.root, dir)))?.scripts
    for (const name of INSTALL_SCRIPTS) {
      const body = scripts?.[name]
      if (typeof body === 'string' && body.trim()) found[dir ? `${dir}: ${name}` : name] = body
    }
  }
  return found
}

/** What starting the project runs now, as the trust record compares it. */
export interface CurrentScripts {
  /** The app's folder ('.' for the root), its key in `TrustedScripts.starts` */
  app: string
  start: string
  installs: Record<string, string>
}

export async function scriptsOf(project: ProjectInfo): Promise<CurrentScripts> {
  return {
    app: project.appDir ?? '.',
    start: startKey(project),
    installs: await installScriptsOf(project),
  }
}

/**
 * Whether starting now runs something the user hasn't agreed to: the app's script changed
 * since they did, or (for an app never started before) Gui chose it rather than the user.
 * A start command set in Gui was the user's, or approved by them.
 */
export function startChanged(
  project: ProjectInfo,
  now: CurrentScripts,
  saved: TrustedScripts,
  picked: boolean,
): boolean {
  if (project.custom) return false
  const agreed = saved.starts[now.app]
  return agreed === undefined ? !picked : agreed !== now.start
}

/** The record to keep once the user has agreed: install scripts only once they've seen them. */
export function agreedScripts(
  now: CurrentScripts,
  installing: boolean,
  saved: TrustedScripts | null,
): TrustedScripts {
  return {
    starts: { ...saved?.starts, [now.app]: now.start },
    installs: installing ? now.installs : (saved?.installs ?? null),
  }
}

/** The install scripts in `now` that the user hasn't agreed to: new, or changed since. */
export function changedInstalls(
  saved: TrustedScripts['installs'],
  now: Record<string, string>,
): string[] {
  return Object.keys(now).filter((key) => saved?.[key] !== now[key])
}
