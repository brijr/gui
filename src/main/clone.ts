import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { developerTools } from './developer-tools'
import { getShellEnv } from './shell-env'

export interface RepoRef {
  /** What `git clone` is given */
  url: string
  /** The folder it clones into: the repo's name */
  name: string
}

const NAME = /^[\w.-]+$/

/**
 * What someone pastes for a GitHub repo: `owner/repo`, its page's address (with or without
 * `.git`, or a path into it), or an SSH remote. Null for anything else.
 */
export function parseRepo(input: string): RepoRef | null {
  const text = input.trim()
  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text)
  if (ssh) return ref(ssh[1], ssh[2], text)
  // GitHub owners have no dots, so `github.com/x` isn't taken for one.
  const short = /^([\w-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text)
  if (short) return ref(short[1], short[2])
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const [owner, repo] = url.pathname.split('/').filter(Boolean)
  return owner && repo ? ref(owner, repo.replace(/\.git$/, '')) : null
}

function ref(owner: string, repo: string, remote?: string): RepoRef | null {
  if (!NAME.test(owner) || !NAME.test(repo) || repo === '.' || repo === '..') return null
  return { url: remote ?? `https://github.com/${owner}/${repo}.git`, name: repo }
}

/** Clones into `parent/<name>` and returns that folder. Fails if it's already there. */
export async function cloneRepo(repo: RepoRef, parent: string): Promise<string> {
  const dest = join(parent, repo.name)
  if (existsSync(dest)) throw new Error(`${dest} already exists.`)
  await developerTools.requireGit()
  // No prompt for credentials: there's no terminal to answer it, so a private repo fails
  // fast instead of hanging. The user's git credential helper still applies.
  const env = { ...(await getShellEnv()), GIT_TERMINAL_PROMPT: '0' }
  await new Promise<void>((ok, fail) => {
    execFile(
      'git',
      ['clone', '--', repo.url, dest],
      { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) return ok()
        const detail = stderr.trim().split('\n').at(-1) || error.message
        fail(new Error(`Couldn't clone ${repo.name}: ${detail.replace(/^fatal: /, '')}`))
      },
    )
  })
  return dest
}
