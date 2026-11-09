import { access, open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import type { AgentCommand } from '../shared/types'

/**
 * Agents that don't offer their skills as commands over ACP (both send none) but load one
 * when the message names it. Gui lists the skills they can find in the composer's menu.
 * Claude Code, Codex, Grok, Muse and Pi list their skills themselves.
 *
 * Folders are listed in the order the agent prefers them (the first skill of a name
 * shows). A project folder is looked for in the project and each folder above it,
 * nearest first; a user folder in the home folder.
 * Checked against opencode 2.2.6 (config/plugin/skill.ts, compatibility.ts, discovery.ts)
 * and fx 0.0.16 (src/builtins/skills.zig, src/core/skills/skill_runtime.zig).
 */
interface Source {
  folders: { dir: string; in: 'project' | 'user' }[]
  /** OpenCode walks up to `/`; fx stops below the home folder */
  stopAtHome: boolean
  /** How deep below a skills folder a skill's folder may be */
  depth: number
  /** The skill as the menu writes it: OpenCode's is named in words; fx's is a `$name` */
  entry(id: string, skill: ParsedSkill): AgentCommand | null
}

const SOURCES: Partial<Record<string, (env: NodeJS.ProcessEnv) => Source>> = {
  opencode: (env) => {
    // A later source wins in OpenCode: .opencode, then .agents, then .claude.
    const claude =
      env.OPENCODE_DISABLE_CLAUDE_CODE || env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS
        ? []
        : ['.claude/skills']
    const config = env.OPENCODE_CONFIG_DIR || '.config/opencode'
    return {
      folders: [
        ...project('.opencode/skills', '.opencode/skill'),
        ...user(`${config}/skills`, `${config}/skill`),
        ...both('.agents/skills', ...claude),
      ],
      stopAtHome: false,
      depth: 6,
      // The folder is the skill's ID, which its tool loads; the frontmatter name is a label.
      entry: (id, skill) => words(id, skill.description),
    }
  },
  fx: () => ({
    folders: [
      ...project(
        '.fx/skills',
        'skills',
        '.opencode/skills',
        '.codex/skills',
        '.claude/skills',
        '.agents/skills',
        '.claw/skills',
      ),
      ...user(
        '.fx/skills',
        '.config/opencode/skills',
        '.codex/skills',
        '.claude/skills',
        '.agents/skills',
        '.claw/skills',
      ),
    ],
    stopAtHome: true,
    depth: 1,
    // fx loads `$name` anywhere in a message. Its frontmatter needs a name (the folder's
    // when there's no frontmatter), which can have spaces; those are named in words.
    entry: (id, skill) => {
      const name = skill.frontmatter ? skill.name : id
      if (!name || !FX_NAME.test(name) || name === '.' || name === '..') return null
      return /\s/.test(name)
        ? words(name, skill.description)
        : { name: `$${name}`, description: skill.description, hint: null }
    },
  }),
}

const project = (...dirs: string[]) => dirs.map((dir) => ({ dir, in: 'project' as const }))
const user = (...dirs: string[]) => dirs.map((dir) => ({ dir, in: 'user' as const }))
/** Each folder in the project, then in the home folder */
const both = (...dirs: string[]) => dirs.flatMap((dir) => [...project(dir), ...user(dir)])

/** fx's rule: up to 256 characters, no control characters or slashes. */
const FX_NAME = /^[^\p{Cc}/\\]{1,256}$/u

const words = (name: string, description: string): AgentCommand => ({
  name,
  description,
  hint: null,
  skill: true,
})

/** More than anyone keeps; a huge folder can't flood the menu or slow the scan. */
const MAX_SKILLS = 200
const MAX_FOLDERS = 2000
/** The frontmatter is at the top; no need to read a long skill's body. */
const HEAD_BYTES = 16 * 1024

/**
 * The skills `agentId` can load in `root`, as the composer's menu lists them; the first of
 * each name wins. Empty for an agent that lists its skills itself. Never rejects.
 */
export async function findSkills(
  agentId: string,
  root: string,
  home = homedir(),
  env = process.env,
): Promise<AgentCommand[]> {
  const source = SOURCES[agentId]?.(env)
  if (!source) return []
  const above = projectFolders(root, source.stopAtHome ? home : null)
  const folders = source.folders.flatMap(({ dir, in: where }) =>
    where === 'user' ? [join(home, dir)] : above.map((folder) => join(folder, dir)),
  )
  const skills = new Map<string, AgentCommand>()
  const budget = { folders: MAX_FOLDERS }
  for (const folder of new Set(folders)) {
    for (const [id, path] of await skillFolders(folder, source.depth, budget)) {
      if (skills.size >= MAX_SKILLS) break
      const head = await readHead(join(path, 'SKILL.md'))
      const entry = head === null ? null : source.entry(id, parseSkill(head))
      const key = entry?.name.toLowerCase()
      if (entry && key && !skills.has(key)) skills.set(key, entry)
    }
  }
  return [...skills.values()]
}

/** The agent's own commands, then the skills not named like one of them. */
export function withSkills(own: AgentCommand[], skills: AgentCommand[]): AgentCommand[] {
  const names = new Set(own.map((command) => command.name.toLowerCase()))
  return [...own, ...skills.filter((skill) => !names.has(skill.name.toLowerCase()))]
}

/**
 * `root` and the folders above it, nearest first: up to `/`, or with `home`, up to the
 * folder below it (from outside the home folder, still up to `/`).
 */
function projectFolders(root: string, home: string | null) {
  const folders: string[] = []
  const underHome = home !== null && root.startsWith(home + sep)
  for (let folder = root; ; folder = dirname(folder)) {
    if (underHome && folder === home) break
    folders.push(folder)
    if (dirname(folder) === folder) break
  }
  return folders
}

/**
 * The skills in a skills folder, as [id, folder]: each folder holding a SKILL.md, found
 * up to `depth` levels down (hidden folders and node_modules aside), its name the ID.
 */
async function skillFolders(
  folder: string,
  depth: number,
  budget: { folders: number },
): Promise<[string, string][]> {
  if (depth < 1 || budget.folders <= 0) return []
  let entries: string[]
  try {
    entries = (await readdir(folder)).sort()
  } catch {
    return []
  }
  const found: [string, string][] = []
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    if (budget.folders-- <= 0) break
    const path = join(folder, entry)
    // stat follows a symlinked skill folder, as both agents do.
    if (!(await stat(path).catch(() => null))?.isDirectory()) continue
    if (await exists(join(path, 'SKILL.md'))) found.push([basename(path), path])
    else found.push(...(await skillFolders(path, depth - 1, budget)))
  }
  return found
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readHead(path: string) {
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export interface ParsedSkill {
  /** The file opens with YAML frontmatter */
  frontmatter: boolean
  name: string | null
  /** On one line; empty without one */
  description: string
}

/**
 * A SKILL.md's `name` and `description`, from the YAML frontmatter at its top. Handles the
 * forms skills use: plain, quoted, and `>`/`|` block values.
 */
export function parseSkill(text: string): ParsedSkill {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { frontmatter: false, name: null, description: '' }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  const body = lines.slice(1, end === -1 ? lines.length : end)
  return {
    frontmatter: true,
    name: field(body, 'name'),
    description: (field(body, 'description') ?? '').replace(/\s+/g, ' ').trim(),
  }
}

function field(lines: string[], key: string): string | null {
  const index = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (index === -1) return null
  const value = lines[index]?.slice(key.length + 1).trim() ?? ''
  if (/^[>|][+-]?$/.test(value)) {
    // A block: the indented lines that follow.
    const block: string[] = []
    for (const line of lines.slice(index + 1)) {
      if (line.trim() && !/^\s/.test(line)) break
      block.push(line.trim())
    }
    return block.join(value.startsWith('>') ? ' ' : '\n').trim() || null
  }
  const quoted = /^(["'])(.*)\1$/.exec(value)
  if (quoted) {
    const inner = quoted[2] ?? ''
    return (quoted[1] === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"')) || null
  }
  return value.replace(/\s+#.*$/, '').trim() || null
}
