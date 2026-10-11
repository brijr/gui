import { constants, type Dirent } from 'node:fs'
import { type FileHandle, lstat, open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type Change, CommandError, git, gitOrNull, type Repo, tail } from './git'

// Secrets in what would be shared

/** Formats real credentials have, looked for in what a commit or pull request adds. */
const SECRET_FORMATS: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/g, 'an AWS access key'],
  [/\b[rs]k_live_[0-9A-Za-z]{16,}/g, 'a Stripe live key'],
  [/\b(?:gh[oprsu]_[0-9A-Za-z]{30,}|github_pat_\w{30,})/g, 'a GitHub token'],
  [/\bxox[abposr]-[0-9A-Za-z-]{10,}/g, 'a Slack token'],
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g, 'a private key'],
  [/\bAIza[\w-]{35}/g, 'a Google API key'],
  [/\bsk-ant-[\w-]{20,}/g, 'an Anthropic API key'],
  [/\bsk-(?:proj-[\w-]{20,}|[0-9A-Za-z]{32,})/g, 'an OpenAI API key'],
]
/** Docs' sample credentials (AWS's `AKIAIOSFODNN7EXAMPLE`) aren't secret. */
const EXAMPLE_SECRET = /example/i

/** Bigger files are left unscanned, as are files past the total. */
const SCAN_FILE_BYTES = 1024 * 1024
const SCAN_TOTAL_BYTES = 8 * 1024 * 1024
// Plain unified diffs whatever the user's config: no external diff programs or textconv
// filters (repo config can name both), fixed prefixes, and only the changed lines.
const DIFF_OPTIONS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--unified=0',
  '--find-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

/** `.env`, `.env.local`, `.env.development.local`… */
const LOCAL_ENV_FILE = /^\.env(?:\.[^.]+)?\.local$|^\.env$/i
const ENV_SEARCH_DEPTH = 3
const ENV_SEARCH_DIRS = 2000
const ENV_SKIPPED_DIRS = new Set(['node_modules', '.git'])
const ENV_FILE_BYTES = 256 * 1024
/** Frameworks build these into every page, so they're public by design. */
const PUBLIC_ENV_KEY = /^(?:NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|REACT_APP|GATSBY|NUXT_PUBLIC)_/i

interface EnvValue {
  value: string
  /** The env file it's from, relative to the work tree, e.g. `apps/web/.env.local` */
  file: string
}

export function leakMessage(where: string, kind: string): string {
  return `${where} looks like it contains a secret (${kind}). Remove it, then try again.`
}

/** The kind of secret in `text`, e.g. "an AWS access key"; null when there's none. */
export function secretIn(text: string, env: EnvValue[]): string | null {
  for (const [pattern, kind] of SECRET_FORMATS) {
    for (const match of text.matchAll(pattern)) {
      if (!EXAMPLE_SECRET.test(match[0])) return kind
    }
  }
  const found = env.find(({ value }) => text.includes(value))
  return found ? `a value from \`${found.file}\`` : null
}

/**
 * Why committing `changes` would share a secret, naming the file but never the secret;
 * null when it wouldn't. Only what the commit adds counts, so a key already in the
 * repository doesn't block every later change to its file.
 */
export async function findLeak(
  repo: Repo,
  changes: Change[],
  env: EnvValue[],
): Promise<string | null> {
  let added: Map<string, string>
  try {
    added = await addedText(repo, changes)
  } catch (error) {
    const output = error instanceof CommandError ? error.output : String(error)
    return `Couldn’t check the changes for secrets:\n${tail(output)}`
  }
  for (const [path, text] of added) {
    const kind = secretIn(text, env)
    if (kind) return leakMessage(`\`${path}\``, kind)
  }
  return null
}

/**
 * What each change adds: a new file's whole text, or the added lines of its diff from
 * HEAD (the working tree is what `commit --only` takes). Binary files aren't read, nor
 * files past the size caps.
 */
async function addedText(repo: Repo, changes: Change[]): Promise<Map<string, string>> {
  const added = new Map<string, string>()
  const kept = changes.filter((change) => change.file.status !== 'deleted')
  const sizes = await Promise.all(
    kept.map((change) => fileSize(resolve(repo.top, change.paths[0] ?? ''))),
  )
  const diffed: string[][] = []
  let budget = SCAN_TOTAL_BYTES
  for (const [index, change] of kept.entries()) {
    const path = change.paths[0]
    const size = sizes[index] ?? null
    if (!path || size === null || size > SCAN_FILE_BYTES || size > budget) continue
    budget -= size
    if (change.untracked || !repo.hasHead) {
      const text = await readText(resolve(repo.top, path), size, false)
      if (text !== null) added.set(path, text)
    } else {
      diffed.push(change.paths)
    }
  }
  for (const paths of pathChunks(diffed)) {
    const args = ['-c', 'core.quotePath=false', 'diff', 'HEAD', ...DIFF_OPTIONS, '--', ...paths]
    collectAdded(await git(repo, args), added)
  }
  return added
}

/** Each file's `+` lines from a `git diff`, appended to `into`. */
function collectAdded(diff: string, into: Map<string, string>) {
  // Hunk lines start with `+`, `-`, a space or `\`, so a line of content can't pass for
  // a `diff --git` header, and a `+++ ` line is a header only before the first `@@`.
  let path: string | null = null
  let header = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true
      path = null
    } else if (header) {
      if (line.startsWith('+++ ')) path = diffPath(line.slice(4))
      else if (line.startsWith('@@')) header = false
    } else if (path !== null && line.startsWith('+')) {
      into.set(path, `${into.get(path) ?? ''}${line.slice(1)}\n`)
    }
  }
}

/** The file a `+++ b/<path>` header names; null for `/dev/null`. */
function diffPath(name: string): string | null {
  // Git ends a name that has spaces with a tab, and C-quotes unusual ones.
  const path = unquote(name.replace(/\t$/, ''))
  return path.startsWith('b/') ? path.slice(2) : null
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/** A path as git prints it: as is, or `"…"` with C escapes and octal bytes. */
function unquote(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const parts: Buffer[] = []
  for (const [part, code] of text.slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/g)) {
    if (code === undefined) parts.push(Buffer.from(part))
    else if (/^[0-7]{3}$/.test(code)) parts.push(Buffer.from([Number.parseInt(code, 8)]))
    else parts.push(Buffer.from([C_ESCAPES[code] ?? code.charCodeAt(0)]))
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Paths for git's command line in batches, keeping both sides of a rename together. */
function pathChunks(groups: string[][], max = 200): string[][] {
  const chunks: string[][] = []
  let chunk: string[] = []
  for (const group of groups) {
    if (chunk.length > 0 && chunk.length + group.length > max) {
      chunks.push(chunk)
      chunk = []
    }
    chunk.push(...group)
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * Long, credential-looking values from env files git doesn't track (`.env.local`), at
 * the top of the work tree and a few folders down. A tracked env file's values are
 * already in the repository.
 */
export async function localEnvValues(repo: Repo): Promise<EnvValue[]> {
  const files = await localEnvFiles(repo.top)
  if (files.length === 0) return []
  const tracked = new Set(
    ((await gitOrNull(repo, ['ls-files', '-z', '--', ...files])) ?? '').split('\0'),
  )
  const values = new Map<string, string>()
  for (const file of files) {
    if (tracked.has(file)) continue
    const text = await readText(join(repo.top, file), ENV_FILE_BYTES, true)
    for (const [key, value] of parseEnv(text ?? '')) {
      if (!values.has(value) && credentialLike(key, value)) values.set(value, file)
    }
  }
  return [...values].map(([value, file]) => ({ value, file }))
}

async function localEnvFiles(top: string): Promise<string[]> {
  const found: string[] = []
  let level = ['']
  let budget = ENV_SEARCH_DIRS
  for (let depth = 0; depth <= ENV_SEARCH_DEPTH && level.length > 0; depth++) {
    const dirs = level.slice(0, budget)
    budget -= dirs.length
    const listings = await Promise.all(
      dirs.map((dir) => readdir(join(top, dir), { withFileTypes: true }).catch((): Dirent[] => [])),
    )
    level = []
    for (const [index, entries] of listings.entries()) {
      const dir = dirs[index]
      for (const entry of entries) {
        const path = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!ENV_SKIPPED_DIRS.has(entry.name)) level.push(path)
        } else if (LOCAL_ENV_FILE.test(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
          found.push(path)
        }
      }
    }
  }
  return found
}

/** `KEY=value` lines, read the way dotenv does: `export`, quotes, trailing comments. */
function parseEnv(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/.exec(line)
    if (!match?.[1] || match[2] === undefined) continue
    let value = match[2].trim()
    const quote = value.charAt(0)
    if (quote === '"' || quote === "'" || quote === '`') {
      const end = value.indexOf(quote, 1)
      value = end === -1 ? value.slice(1) : value.slice(1, end)
    } else {
      const comment = value.search(/\s#/)
      if (comment !== -1) value = value.slice(0, comment).trimEnd()
    }
    pairs.push([match[1], value])
  }
  return pairs
}

/**
 * Whether an env value is worth looking for. Plain settings like `http://localhost:3000`,
 * an email address or a project name turn up in code for good reasons; credentials are
 * 12+ characters of letters and digits, or a URL with a password or a token in it.
 */
function credentialLike(key: string, value: string): boolean {
  if (value.length < 12 || /\s/.test(value) || PUBLIC_ENV_KEY.test(key)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.password !== '' || /[A-Za-z0-9]{16,}/.test(`${url.pathname}${url.search}`)
    } catch {
      return false
    }
  }
  return /[A-Za-z]/.test(value) && /\d/.test(value)
}

/** Size of a regular file; null for anything else (gone, a symlink, a submodule). */
async function fileSize(path: string): Promise<number | null> {
  try {
    const stats = await lstat(path)
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

/**
 * Up to `max` bytes of a regular file as text; null for binary files (a NUL early on,
 * as git decides) and anything that isn't a file. Never blocks on a FIFO.
 */
async function readText(path: string, max: number, follow: boolean): Promise<string | null> {
  let file: FileHandle | undefined
  try {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW)
    file = await open(path, flags)
    if (!(await file.stat()).isFile()) return null
    const buffer = Buffer.alloc(max)
    const { bytesRead } = await file.read(buffer, 0, max, 0)
    const data = buffer.subarray(0, bytesRead)
    return data.subarray(0, 8000).includes(0) ? null : data.toString('utf8')
  } catch {
    return null
  } finally {
    await file?.close()
  }
}
