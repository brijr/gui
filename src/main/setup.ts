import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, posix } from 'node:path'
import type { PackageManager, ProjectInfo, ProjectSetup, WorkspaceApp } from '../shared/types'
import { type InstallRecord, installedStamps, recordInstall } from './install-state'
import {
  detectPackageManager,
  exists,
  expandPatterns,
  type PackageJson,
  readPackageJson,
  realRelative,
  workspacePatterns,
} from './project'

const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template']
/** Any of these means the env is already set up. */
const ENV_LOCALS = ['.env', '.env.local', '.env.development.local']
/** Next.js and Vite both load it, and their templates gitignore `*.local`. */
const ENV_TARGET = '.env.local'

const MISSING_TOOL: Record<PackageManager, string> = {
  bun: "bun isn't installed on this Mac. Install it from bun.sh, then try again.",
  pnpm: "pnpm isn't installed on this Mac. Install it from pnpm.io (or run `corepack enable pnpm`), then try again.",
  yarn: "Yarn isn't installed on this Mac. Install it from yarnpkg.com (or run `corepack enable yarn`), then try again.",
  npm: "Node.js isn't set up on this Mac yet. Set it up from the card above, then try again.",
}

export const installCommand = (pm: PackageManager) => `${pm} install`

/** Package manager bins and the package manager each needs (`npx` is npm's). */
const TOOL_OF: Record<string, PackageManager> = {
  bun: 'bun',
  bunx: 'bun',
  pnpm: 'pnpm',
  pnpx: 'pnpm',
  yarn: 'yarn',
  npm: 'npm',
  npx: 'npm',
}

/** The package manager a start command runs with (`pnpm run dev`), or null for anything else. */
export function packageManagerOf(command: string): PackageManager | null {
  const words = command.trim().split(/\s+/)
  while (words[0] && /^\w+=/.test(words[0])) words.shift()
  return TOOL_OF[words[0] ?? ''] ?? null
}

/** What the project needs before its preview can run; null when nothing. */
export async function detectSetup(
  project: ProjectInfo,
  apps: WorkspaceApp[] | null,
): Promise<ProjectSetup | null> {
  const [installs, env] = await Promise.all([
    apps ? [] : installsNeeded(project),
    detectEnv(project.root, project.appDir),
  ])
  return settleSetup({ apps, dependencies: installs.length ? 'missing' : 'ok', env })
}

/** Null once there's nothing left to do or show. */
export function settleSetup(setup: ProjectSetup): ProjectSetup | null {
  return setup.apps || setup.dependencies !== 'ok' || setup.env || setup.node ? setup : null
}

function declaresDependencies(pkg: PackageJson) {
  const has = (value: unknown) =>
    !!value && typeof value === 'object' && Object.keys(value).length > 0
  return has(pkg.dependencies) || has(pkg.devDependencies) || pkg.workspaces !== undefined
}

/** A folder Gui installs dependencies in: the (workspace) root, or an app with its own. */
export interface InstallTarget {
  /** Relative to the project root, POSIX; '' for the root */
  dir: string
  packageManager: PackageManager
  /** Its package.json dependencies and lockfile as they are now (`dependencyStamp`) */
  stamp: string
}

const LOCKFILE_NAMES = [
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
]
/** What else decides what an install puts in node_modules (pnpm's catalogs, Yarn's settings). */
const INSTALL_CONFIG = ['pnpm-workspace.yaml', '.yarnrc.yml', '.npmrc']
/** The package.json fields an install reads; editing a script doesn't need a new install. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'overrides',
  'resolutions',
  'pnpm',
  'workspaces',
  'packageManager',
] as const
/** Lockfiles past this are hashed by their size and time, not read. */
const MAX_HASHED_FILE = 64 * 1024 * 1024

/**
 * Where the project installs: its root when that declares dependencies, and the folder its
 * app runs in when that has a package.json of its own outside the root's workspaces (an
 * app in `web/` next to a backend). Each comes with its stamp.
 */
export async function installTargets(project: ProjectInfo): Promise<InstallTarget[]> {
  const { root, appDir } = project
  const rootPkg = await readPackageJson(root)
  const targets: InstallTarget[] = []
  const workspaces = await expandPatterns(root, await workspacePatterns(root, rootPkg))
  if (rootPkg && declaresDependencies(rootPkg)) {
    targets.push({
      dir: '',
      packageManager: await detectPackageManager(root, rootPkg),
      stamp: await dependencyStamp(root, rootPkg, workspaces),
    })
  }
  if (appDir && !workspaces.includes(appDir) && (await realRelative(root, join(root, appDir)))) {
    const appPkg = await readPackageJson(join(root, appDir))
    if (appPkg && declaresDependencies(appPkg)) {
      const dir = join(root, appDir)
      targets.push({
        dir: appDir,
        packageManager: await detectPackageManager(dir, appPkg),
        stamp: await dependencyStamp(dir, appPkg, []),
      })
    }
  }
  return targets
}

/**
 * The install folders that need an install before the app starts: one with no node_modules
 * (a fresh clone), or whose dependencies or lockfile changed since Gui last installed them
 * (a `git pull`, the agent adding a package). One Gui never installed but that has its
 * node_modules is taken as installed, and its stamp recorded from then on.
 */
export async function installsNeeded(project: ProjectInfo): Promise<InstallTarget[]> {
  const [targets, recorded] = await Promise.all([
    installTargets(project),
    installedStamps(project.root).catch((): InstallRecord => ({})),
  ])
  const needed: InstallTarget[] = []
  for (const target of targets) {
    const dir = join(project.root, target.dir)
    const installed =
      (await exists(join(dir, 'node_modules'))) || (await exists(join(dir, '.pnp.cjs')))
    const saved = recorded[target.dir]
    if (!installed || (saved !== undefined && saved !== target.stamp)) needed.push(target)
    else if (saved === undefined) {
      await recordInstall(project.root, target.dir, target.stamp).catch(() => undefined)
    }
  }
  return needed
}

/** After an install succeeds: what it installed from (lockfiles change as it runs). */
export async function recordInstalled(project: ProjectInfo, dir: string) {
  const target = (await installTargets(project)).find((t) => t.dir === dir)
  if (target) await recordInstall(project.root, dir, target.stamp)
}

/**
 * A hash of what an install in `dir` reads: package.json's dependency fields (and its
 * workspaces' too), the lockfile, and package manager settings that change the result.
 */
export async function dependencyStamp(
  dir: string,
  pkg: PackageJson,
  workspaces: string[],
): Promise<string> {
  const hash = createHash('sha256')
  const fields = (p: PackageJson | null) =>
    JSON.stringify(DEPENDENCY_FIELDS.map((field) => [field, p?.[field as keyof PackageJson]]))
  hash.update(fields(pkg))
  for (const workspace of workspaces) {
    hash.update(`\0${workspace}\0${fields(await readPackageJson(join(dir, workspace)))}`)
  }
  for (const name of [...LOCKFILE_NAMES, ...INSTALL_CONFIG]) {
    hash.update(`\0${name}\0${await fileStamp(join(dir, name))}`)
  }
  return hash.digest('hex')
}

/** A regular file's contents (its size and time when huge); '' when there's none. */
async function fileStamp(path: string): Promise<string> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return ''
    if (info.size > MAX_HASHED_FILE) return `${info.size}:${info.mtimeMs}`
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  } catch {
    return ''
  }
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
