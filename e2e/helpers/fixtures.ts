import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './env'

export type FixtureName = 'vite' | 'next'

export interface FixtureSpec {
  name: FixtureName
  /** Executable in node_modules/.bin that proves the dependencies are installed. */
  bin: string
  /** Text of the page's <h1>. */
  heading: string
  /** CSS selector of the element the tests pick. */
  selector: string
  /** Text the picked element contains. */
  text: string
  /** Project-relative file whose JSX renders the picked element. */
  file: string
  /** Text that appears exactly once in `file`, on the picked element's opening tag. */
  marker: string
  /** React owner chain of the picked element, innermost first. */
  components: string[]
}

export const FIXTURES: FixtureSpec[] = [
  {
    name: 'vite',
    bin: 'vite',
    heading: 'Gui Vite fixture',
    selector: 'button.counter',
    text: 'count is',
    file: 'src/App.tsx',
    marker: 'className="counter"',
    components: ['App'],
  },
  {
    name: 'next',
    bin: 'next',
    heading: 'Gui Next fixture',
    selector: '[data-testid="hero-btn"]',
    text: 'Clicked',
    file: 'components/hero.tsx',
    marker: 'data-testid="hero-btn"',
    components: ['Hero', 'Home'],
  },
]

const sourceDir = (name: FixtureName) => join(REPO_ROOT, 'e2e', 'fixtures', name)

// Dependencies

function dependencyStamp(dir: string): string {
  const hash = createHash('sha1')
  for (const file of ['package.json', 'bun.lock']) hash.update(readFileSync(join(dir, file)))
  return hash.digest('hex')
}

function readStamp(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/**
 * Installs a fixture's dependencies in place, once. The stamp records which
 * package.json/bun.lock the install came from, so a changed fixture reinstalls.
 */
export function ensureFixtureDependencies(spec: FixtureSpec): void {
  const dir = sourceDir(spec.name)
  const modules = join(dir, 'node_modules')
  const stampFile = join(modules, '.gui-e2e-stamp')
  const installed = existsSync(join(modules, '.bin', spec.bin))
  if (installed && readStamp(stampFile) === dependencyStamp(dir)) return
  console.log(`[e2e] installing dependencies for the ${spec.name} fixture`)
  const result = spawnSync('bun', ['install'], { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`bun install failed in ${dir} (is bun on PATH? exit ${result.status})`)
  }
  // Hash after installing: bun may normalize bun.lock.
  writeFileSync(stampFile, dependencyStamp(dir))
}

// Git

const GIT_CONFIG = [
  '-c',
  'user.name=Gui E2E',
  '-c',
  'user.email=e2e@example.com',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    delete env[key]
  }
  return env
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const detail = result.stderr || result.error?.message
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`)
  }
  return result.stdout
}

/** `git status --porcelain` of the fixture copy; empty string means a clean tree. */
/**
 * Changes to the fixture's own files. Untracked files are ignored: the developer's agent
 * setup (e.g. Claude Code hooks) may drop tool caches into any project it works in.
 */
export function gitStatus(root: string): string {
  return git(root, 'status', '--porcelain', '--untracked-files=no').trim()
}

// Per-test copies

export interface FixtureCopy {
  spec: FixtureSpec
  /** Scratch directory that holds the project and the Electron user-data directory. */
  base: string
  /** Real path of the throwaway project (a git work tree), as the app resolves it. */
  root: string
  /** Electron `--user-data-dir` for this run. */
  userData: string
}

/** Clones a directory tree; on APFS `cp -c` shares blocks, so node_modules is nearly free. */
function copyTree(from: string, to: string): void {
  const attempts = process.platform === 'darwin' ? ['-cR', '-R'] : ['-R']
  for (const flags of attempts) {
    const result = spawnSync('cp', [flags, `${from}/.`, to], { stdio: 'pipe' })
    if (result.status === 0) return
  }
  throw new Error(`Could not copy ${from} to ${to}`)
}

/**
 * A fresh copy of a fixture (node_modules included) with its own git history, so
 * dev-server caches, agent edits and undo never touch the committed fixture.
 * A symlinked node_modules is not an option: Turbopack rejects links that leave the project.
 */
export function createFixtureCopy(name: FixtureName): FixtureCopy {
  const spec = FIXTURES.find((fixture) => fixture.name === name)
  if (!spec) throw new Error(`Unknown fixture: ${name}`)
  const source = sourceDir(name)
  if (!existsSync(join(source, 'node_modules'))) {
    throw new Error(`Dependencies are missing in ${source}; run the suite through playwright`)
  }

  // realpath: the app trusts and compares real paths, and macOS tmp is a symlink.
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-e2e-'))
  const root = join(base, `fixture-${name}`)
  const userData = join(base, 'user-data')
  mkdirSync(root)
  mkdirSync(userData)
  copyTree(source, root)

  git(root, 'init', '--quiet')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'fixture')
  return { spec, base, root, userData }
}

/** Deletes a copy in the background; removing a cloned node_modules takes seconds. */
export function removeFixtureCopy(copy: FixtureCopy): void {
  spawn('rm', ['-rf', copy.base], { detached: true, stdio: 'ignore' }).unref()
}

/** 1-based line number of the one line in `file` that contains `marker`. */
export function lineOf(root: string, file: string, marker: string): number {
  const lines = readFileSync(join(root, file), 'utf8').split('\n')
  const hits = lines.flatMap((text, index) => (text.includes(marker) ? [index + 1] : []))
  const [line] = hits
  if (hits.length !== 1 || line === undefined) {
    throw new Error(`Expected exactly one "${marker}" in ${file}, found ${hits.length}`)
  }
  return line
}
