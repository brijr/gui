import { constants } from 'node:fs'
import { access, lstat, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, posix } from 'node:path'
import type { PackageManager, ProjectInfo, ProjectSetup, WorkspaceApp } from '../shared/types'
import { exists, type PackageJson, readPackageJson, realRelative } from './project'

const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template']
/** Any of these means the env is already set up. */
const ENV_LOCALS = ['.env', '.env.local', '.env.development.local']
/** Next.js and Vite both load it, and their templates gitignore `*.local`. */
const ENV_TARGET = '.env.local'

const MISSING_TOOL: Record<PackageManager, string> = {
  bun: "bun isn't installed on this Mac. Install it from bun.sh, then try again.",
  pnpm: "pnpm isn't installed on this Mac. Install it from pnpm.io (or run `corepack enable pnpm`), then try again.",
  yarn: "Yarn isn't installed on this Mac. Install it from yarnpkg.com (or run `corepack enable yarn`), then try again.",
  npm: "Node.js isn't installed on this Mac. Install it from nodejs.org, then try again.",
}

export const installCommand = (pm: PackageManager) => `${pm} install`

/** What the project needs before its preview can run; null when nothing. */
export async function detectSetup(
  project: ProjectInfo,
  apps: WorkspaceApp[] | null,
): Promise<ProjectSetup | null> {
  const [missing, env] = await Promise.all([
    dependenciesMissing(project.root),
    detectEnv(project.root, project.appDir),
  ])
  return settleSetup({ apps, dependencies: missing ? 'missing' : 'ok', env })
}

/** Null once there's nothing left to do or show. */
export function settleSetup(setup: ProjectSetup): ProjectSetup | null {
  return setup.apps || setup.dependencies !== 'ok' || setup.env ? setup : null
}

function declaresDependencies(pkg: PackageJson) {
  const has = (value: unknown) =>
    !!value && typeof value === 'object' && Object.keys(value).length > 0
  return has(pkg.dependencies) || has(pkg.devDependencies) || pkg.workspaces !== undefined
}

/**
 * A fresh clone has no node_modules at its (workspace) root. Yarn Plug'n'Play installs
 * have none either; their `.pnp.cjs` says they're installed.
 */
async function dependenciesMissing(root: string) {
  const pkg = await readPackageJson(root)
  if (!pkg || !declaresDependencies(pkg)) return false
  const [modules, pnp] = await Promise.all([
    exists(join(root, 'node_modules')),
    exists(join(root, '.pnp.cjs')),
  ])
  return !modules && !pnp
}

async function firstFile(dir: string, names: string[]) {
  for (const name of names) if (await exists(join(dir, name))) return name
  return null
}

/**
 * An env example with no local env file next to it, in the app's folder or else the
 * root. Paths are relative to the root.
 */
export async function detectEnv(root: string, appDir: string | null): Promise<ProjectSetup['env']> {
  for (const dir of appDir ? [appDir, ''] : ['']) {
    const example = await firstFile(join(root, dir), ENV_EXAMPLES)
    if (!example) continue
    if (await firstFile(join(root, dir), ENV_LOCALS)) return null
    return {
      example: posix.join(dir, example),
      target: posix.join(dir, ENV_TARGET),
      created: false,
    }
  }
  return null
}

/**
 * An env file's path, once its folder is known to really be in the project: a symlinked
 * folder on the way (`apps -> ..`) would read, write or open a file outside it.
 */
async function envPath(root: string, file: string) {
  const path = join(root, file)
  if ((await realRelative(root, dirname(path))) === null) {
    throw new Error(`${file} is outside the project`)
  }
  return path
}

/** Copies the example into place, readable only by the user since it will hold secrets. */
export async function createEnvFile(root: string, env: { example: string; target: string }) {
  const [example, target] = await Promise.all([
    envPath(root, env.example),
    envPath(root, env.target),
  ])
  // A symlinked example could copy any file the user can read into the project.
  if (!(await lstat(example)).isFile()) throw new Error(`${env.example} is not a regular file`)
  try {
    // `wx` never overwrites, not even through a symlink planted at the target.
    await writeFile(target, await readFile(example), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    // Created meanwhile (by the user or another window): open what's there, if it's a file.
    await envFile(root, env.target)
  }
}

/**
 * The env file to open, refusing anything but a regular file in the project: a symlink
 * planted there could point Gui at any file or app on the Mac.
 */
export async function envFile(root: string, target: string) {
  const path = await envPath(root, target)
  if (!(await lstat(path)).isFile()) throw new Error(`${target} is not a regular file`)
  return path
}

/** Why the package manager can't run (it isn't on the user's PATH), or null when it can. */
export async function missingPackageManager(pm: PackageManager, env: NodeJS.ProcessEnv) {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, pm), constants.X_OK)
      return null
    } catch {
      // not in this directory
    }
  }
  return MISSING_TOOL[pm]
}
