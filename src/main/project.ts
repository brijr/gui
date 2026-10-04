import type { Dirent } from 'node:fs'
import { access, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, posix, relative, sep } from 'node:path'
import type { PackageManager, ProjectInfo, WorkspaceApp } from '../shared/types'

const LOCKFILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

const DEV_SCRIPTS = ['dev', 'develop', 'start', 'serve']
/** Detection reads project files before the project is trusted, so it only reads small ones. */
const MAX_PROJECT_FILE = 256 * 1024

/** Dependencies that make a workspace package a web app rather than a library. */
const WEB_FRAMEWORKS = new Set([
  'next',
  'vite',
  'astro',
  'nuxt',
  'react-scripts',
  'gatsby',
  '@sveltejs/kit',
  '@react-router/dev',
  '@angular/core',
  '@solidjs/start',
  '@tanstack/react-start',
  '@docusaurus/core',
  'vitepress',
  'parcel',
  'webpack-dev-server',
])
/** Dev server commands a dev script can run directly. */
const FRAMEWORK_BINS = new Set([
  'next',
  'vite',
  'astro',
  'nuxt',
  'nuxi',
  'remix',
  'react-router',
  'react-scripts',
  'gatsby',
  'ng',
  'parcel',
  'webpack-dev-server',
  'vitepress',
  'docusaurus',
  'vinxi',
])
/** Build tools whose watch mode is a library's `dev` script, not a server. */
const BUILD_TOOLS = new Set([
  'tsc',
  'tsup',
  'tsdown',
  'rollup',
  'esbuild',
  'unbuild',
  'babel',
  'swc',
])
/** Tools that run scripts across workspace packages (`turbo dev`, `nx run-many`). */
const WORKSPACE_RUNNERS = new Set([
  'turbo',
  'nx',
  'lerna',
  'concurrently',
  'npm-run-all',
  'npm-run-all2',
  'run-p',
  'run-s',
  'ultra',
  'wireit',
])
const PACKAGE_MANAGERS = new Set(['bun', 'pnpm', 'yarn', 'npm'])
/** Package manager flags that fan a script out to workspaces (`pnpm -r dev`, `bun --filter`). */
const WORKSPACE_FLAG = /^(?:--filter|-F|-r|--recursive|--workspaces?|-ws|-w)(?:=|$)/

export interface PackageJson {
  name?: string
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  workspaces?: unknown
  main?: unknown
  module?: unknown
  exports?: unknown
  types?: unknown
  typings?: unknown
}

interface DevScript {
  name: string
  body: string
}

export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** A regular file of at most MAX_PROJECT_FILE; a FIFO or a huge file must not stall detection. */
async function readProjectFile(path: string) {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_PROJECT_FILE) throw new Error(`${path} is not a small file`)
  return readFile(path, 'utf8')
}

/**
 * `path`'s real location relative to `root`'s, symlinks resolved on both: '' for the root
 * itself, null when it's missing or outside the root.
 */
export async function realRelative(root: string, path: string): Promise<string | null> {
  try {
    const rel = relative(await realpath(root), await realpath(path))
    const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    return outside ? null : rel
  } catch {
    return null
  }
}

export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    const parsed: unknown = JSON.parse(await readProjectFile(join(dir, 'package.json')))
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null
  } catch {
    return null
  }
}

async function detectPackageManager(root: string, pkg: PackageJson | null) {
  const declared = pkg?.packageManager?.split('@')[0]
  if (declared === 'bun' || declared === 'pnpm' || declared === 'yarn' || declared === 'npm') {
    return declared
  }
  for (const [file, pm] of LOCKFILES) {
    if (await exists(join(root, file))) return pm
  }
  return 'npm'
}

function devScriptOf(pkg: PackageJson | null): DevScript | null {
  for (const name of DEV_SCRIPTS) {
    const body = pkg?.scripts?.[name]
    if (typeof body === 'string' && body.trim()) return { name, body }
  }
  return null
}

/** Keys of a package.json dependency map, tolerating malformed values. */
function dependencyNames(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
}

/** A script's commands, split into words with quotes and leading `VAR=value`s dropped. */
function commands(script: string): string[][] {
  return script
    .split(/&&|\|\||[;&|\n]/)
    .map((command) => {
      const words = command
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      while (words[0] && /^\w+=/.test(words[0])) words.shift()
      return words
    })
    .filter((words) => words.length > 0)
}

/** True for `turbo dev`, `pnpm -r dev`, `bun run --filter '*' dev` and the like. */
export function isWorkspaceRunner(script: string): boolean {
  return commands(script).some((words) => {
    if (words.some((word) => WORKSPACE_RUNNERS.has(word))) return true
    const [bin = ''] = words
    return (
      PACKAGE_MANAGERS.has(bin) &&
      words.some(
        (word) => WORKSPACE_FLAG.test(word) || word === 'workspace' || word === 'workspaces',
      )
    )
  })
}

/** Workspace globs from package.json (`[...]` or `{ packages: [...] }`) and pnpm-workspace.yaml. */
async function workspacePatterns(root: string, pkg: PackageJson | null): Promise<string[]> {
  const declared = pkg?.workspaces
  const list =
    declared && typeof declared === 'object' && !Array.isArray(declared)
      ? (declared as { packages?: unknown }).packages
      : declared
  const fromPackage = Array.isArray(list)
    ? list.filter((p): p is string => typeof p === 'string')
    : []
  return [...fromPackage, ...(await pnpmWorkspacePatterns(root))]
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * `packages:` of pnpm-workspace.yaml, read line by line (block or flow list). String methods
 * rather than regexes: the file is read before the project is trusted, and a regex like
 * `\s+#.*$` takes quadratic time on a crafted line, long enough to freeze the app.
 */
async function pnpmWorkspacePatterns(root: string): Promise<string[]> {
  let text: string
  try {
    text = await readProjectFile(join(root, 'pnpm-workspace.yaml'))
  } catch {
    return []
  }
  const patterns: string[] = []
  let inPackages = false
  for (const raw of text.split(/\r?\n/)) {
    const content = raw.trimStart()
    if (!content || content.startsWith('#')) continue
    const line = stripComment(raw)
    if (content === raw) {
      // A top-level key: the list starts at `packages:` and ends at the next key.
      const value = packagesValue(line)
      inPackages = value !== undefined && !value.startsWith('[')
      if (value?.startsWith('['))
        patterns.push(
          ...value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map(unquote),
        )
      continue
    }
    const item = line.trimStart()
    if (inPackages && item.startsWith('-')) patterns.push(unquote(item.slice(1)))
  }
  return patterns.filter(Boolean)
}

/** Drops a trailing ` # comment`. */
function stripComment(line: string) {
  const hashes = [line.indexOf(' #'), line.indexOf('\t#')].filter((i) => i >= 0)
  return hashes.length ? line.slice(0, Math.min(...hashes)).trimEnd() : line
}

/** What follows `packages:` on a top-level line, trimmed; undefined for any other key. */
function packagesValue(line: string) {
  if (!line.startsWith('packages')) return undefined
  const rest = line.slice('packages'.length).trimStart()
  return rest.startsWith(':') ? rest.slice(1).trim() : undefined
}

async function isRealDirectory(path: string) {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Expands simple workspace globs (`apps/*`, `packages/ui`); `**` and negations are skipped.
 * A symlinked folder on the way (`up/*` with `up -> ..`) could reach outside the project, so
 * matches are resolved to where they really are, and must be inside it: the dev server runs
 * there and env files land there. That also lists a folder reached two ways only once.
 */
async function expandPatterns(root: string, patterns: string[]): Promise<string[]> {
  const dirs = new Set<string>()
  for (const raw of patterns) {
    const pattern = trimTrailingSlashes(raw.trim().replace(/^\.\//, ''))
    const segments = pattern.split('/')
    if (!pattern || pattern.startsWith('!') || pattern.startsWith('/')) continue
    if (segments.some((segment) => segment === '**' || segment === '..' || segment === '.'))
      continue
    for (const dir of await matchSegments(root, '', segments)) dirs.add(dir)
  }
  const real = await Promise.all([...dirs].map((dir) => realRelative(root, join(root, dir))))
  // '' is the root itself, which isn't one of its apps.
  return [...new Set(real.flatMap((dir) => (dir ? [dir] : [])))].sort()
}

/** `apps/` → `apps`. A loop: `/\/+$/` is quadratic on a long run of slashes. */
function trimTrailingSlashes(path: string) {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

/**
 * `*` and `?` wildcards against a name. Not a regex: workspace globs come from the project,
 * and `*a*a*a…` would backtrack exponentially. This only ever returns to the last `*`.
 */
function matchesGlob(pattern: string, name: string): boolean {
  let p = 0
  let n = 0
  let star = -1
  let resume = 0
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p++
      n++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      resume = n
    } else if (star >= 0) {
      p = star + 1
      n = ++resume
    } else {
      return false
    }
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

async function matchSegments(root: string, base: string, segments: string[]): Promise<string[]> {
  const [segment, ...rest] = segments
  if (segment === undefined) return base && (await isRealDirectory(join(root, base))) ? [base] : []
  if (!/[*?]/.test(segment)) return matchSegments(root, posix.join(base, segment), rest)
  let entries: Dirent[]
  try {
    entries = await readdir(join(root, base), { withFileTypes: true })
  } catch {
    return []
  }
  const matches = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name !== 'node_modules' &&
      matchesGlob(segment, entry.name),
  )
  const nested = await Promise.all(
    matches.map((entry) => matchSegments(root, posix.join(base, entry.name), rest)),
  )
  return nested.flat()
}

/**
 * How likely a workspace package is to be something to preview: 2 for a web framework,
 * 1 for anything else that isn't clearly a library, 0 for a library whose `dev` script
 * rebuilds it on change (`tsup --watch`).
 */
function appScore(pkg: PackageJson, script: DevScript): number {
  const words = commands(script.body).flat()
  const watches = words.some((word) => word === '--watch' || word === '-w' || word === 'watch')
  const builds = words.some((word) => word === 'build' || BUILD_TOOLS.has(word))
  if (watches && builds) return 0
  const deps = [...dependencyNames(pkg.dependencies), ...dependencyNames(pkg.devDependencies)]
  const framework =
    deps.some((name) => WEB_FRAMEWORKS.has(name) || name.startsWith('@remix-run/')) ||
    words.some((word) => FRAMEWORK_BINS.has(word))
  if (framework) return 2
  const library = ['main', 'module', 'exports', 'types', 'typings'].some(
    (field) => pkg[field as keyof PackageJson] !== undefined,
  )
  return library ? 0 : 1
}

interface Workspace extends WorkspaceApp {
  script: DevScript
}

/** Workspace packages with a dev script, keeping only the most app-like ones. */
async function findApps(root: string, pkg: PackageJson | null): Promise<Workspace[]> {
  const dirs = await expandPatterns(root, await workspacePatterns(root, pkg))
  const found = await Promise.all(
    dirs.map(async (dir) => {
      const child = await readPackageJson(join(root, dir))
      const script = devScriptOf(child)
      if (!child || !script) return null
      const app: Workspace = { dir, name: child.name || basename(dir), script }
      return { app, score: appScore(child, script) }
    }),
  )
  const scored = found.filter((entry) => entry !== null)
  const best = Math.max(...scored.map((entry) => entry.score))
  return scored.filter((entry) => entry.score === best).map((entry) => entry.app)
}

export interface DetectedProject {
  project: ProjectInfo
  /**
   * The monorepo's apps Grat can preview; empty outside a monorepo or when the root's
   * own dev script runs the app. Several with no `project.appDir` means "ask the user".
   */
  apps: WorkspaceApp[]
}

/**
 * Finds what to run. In a monorepo whose root dev script starts every package at once
 * (turbo, `pnpm -r`), Grat runs one app instead: the remembered `preferredApp`, the only
 * one there is, or (with several) the one the user picks.
 */
export async function detectProject(
  root: string,
  preferredApp: string | null = null,
): Promise<DetectedProject> {
  const pkg = await readPackageJson(root)
  const packageManager = await detectPackageManager(root, pkg)
  const base = { root, name: pkg?.name || basename(root), packageManager }
  const run = (script: DevScript | null, appDir: string | null): ProjectInfo => ({
    ...base,
    devCommand: script ? `${packageManager} run ${script.name}` : null,
    devScript: script?.body ?? null,
    appDir,
  })

  const rootScript = devScriptOf(pkg)
  if (rootScript && !isWorkspaceRunner(rootScript.body)) {
    return { project: run(rootScript, null), apps: [] }
  }
  const workspaces = await findApps(root, pkg)
  // No app to pick: fall back to the root's script, runner or not.
  if (workspaces.length === 0) return { project: run(rootScript, null), apps: [] }

  const apps = workspaces.map(({ dir, name }) => ({ dir, name }))
  const chosen =
    workspaces.find((app) => app.dir === preferredApp) ??
    (workspaces.length === 1 ? workspaces[0] : undefined)
  return { project: chosen ? run(chosen.script, chosen.dir) : run(null, null), apps }
}
