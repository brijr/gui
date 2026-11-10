import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import type { AgentId } from '../shared/types'
import { getPrefs, setPrefs } from './prefs'

/**
 * Auto mode (`ChatMeta.autoApprove`): on for every project unless the user turned it off
 * there, which prefs remember by project root. Chats follow it through `prefsEvents`.
 */
export function setAutoApprove(root: string, on: boolean) {
  const roots = getPrefs().askRoots
  if (roots.includes(root) !== on) return
  setPrefs({ askRoots: on ? roots.filter((saved) => saved !== root) : [...roots, root] })
}

export function isAutoApprove(root: string) {
  return !getPrefs().askRoots.includes(root)
}

const JSON_FILE = 'json[c5]?'
const YAML_FILE = 'ya?ml'
const CODE_FILE = '[cm]?[jt]s'
/** Makefile, justfile, Taskfile, Rakefile, Gemfile, Podfile, Pipfile, Brewfile, Procfile… */
const NAMED_FILES =
  'make|gnumake|just|task|rake|gem|pod|pip|brew|proc|jenkins|vagrant|tilt|earth|gulp|grunt'

/**
 * Sensitive file names, in any folder, by family, so the next tool's file is one too.
 * JSON and YAML also hold ordinary content (`src/data/products.json`, `content/post.yaml`),
 * so in those formats a file is sensitive by its name, never by its extension. Source files
 * named after a tool (`src/lib/firebase.ts`) are ordinary.
 */
const SENSITIVE_NAMES = [
  // Scripts.
  '[^/]*\\.(sh|bash|zsh)',
  // Config: named as config (vite.config.ts, babel.config.json), a TypeScript or JavaScript
  // project's own, and the formats only config is written in.
  `[^/]*\\.config(\\.(${CODE_FILE}|${JSON_FILE}|${YAML_FILE}))?`,
  '[jt]sconfig[^/]*\\.json',
  '[^/]*\\.(toml|ini|cfg|conf)',
  // Containers: Dockerfile, Dockerfile.dev, web.Dockerfile, compose.yaml, docker-compose.yml.
  '([^/]*\\.)?(docker|container)file(\\.[^/]*)?',
  `(docker-)?compose(\\.[^/]*)?\\.${YAML_FILE}`,
  // Lockfiles: yarn.lock, Cargo.lock, bun.lockb, package-lock.json, pnpm-lock.yaml.
  '[^/]*\\.lockb?',
  `[^/]*[-.]lock\\.(${JSON_FILE}|${YAML_FILE})`,
  'npm-shrinkwrap\\.json|go\\.sum|go\\.work\\.sum|package\\.resolved',
  // Workspaces: pnpm-workspace.yaml.
  `[^/]*[-.]workspace\\.(${JSON_FILE}|${YAML_FILE})`,
  'go\\.work',
  // Package manifests, by ecosystem (Cargo.toml and pyproject.toml are TOML, above; Gemfile,
  // Pipfile and Podfile are below).
  `package\\.(json5?|${YAML_FILE})`,
  `(deno|jsr|composer)\\.${JSON_FILE}`,
  `pubspec\\.${YAML_FILE}`,
  '(requirements|constraints)[^/]*\\.(txt|in)',
  'setup\\.py|go\\.mod|pom\\.xml|mix\\.exs|package\\.swift',
  '[^/]*\\.(gemspec|podspec|gradle|gradle\\.kts|csproj|fsproj|vbproj|sln|nix)',
  // Deploy and CI config kept outside dot-folders (netlify.toml and fly.toml are TOML).
  `(vercel|firebase|wrangler|railway)\\.${JSON_FILE}`,
  `(render|apphosting|amplify|serverless|heroku)\\.${YAML_FILE}`,
  `([^/]*-pipelines|cloudbuild|buildspec|appveyor)\\.${YAML_FILE}`,
  // Task runners and tools: turbo.json, Makefile, justfile, Taskfile.yml, Procfile, Gemfile.
  `(turbo|nx|lerna|rush|nodemon|biome)\\.${JSON_FILE}`,
  `([^/]*\\.)?(${NAMED_FILES})file(\\.[^/]*)?`,
  '[^/]*\\.mk',
  // Git-hook runners (husky and pre-commit keep theirs in dotfiles).
  `(lefthook|simple-git-hooks|captainhook)[^/]*\\.(${CODE_FILE}|${JSON_FILE}|${YAML_FILE})`,
]

/**
 * Files that can change how code runs (build/tool config, dependencies, CI, hooks,
 * dotfiles) always need the user's approval, even when edits are otherwise automatic:
 * anything in a dotfile or dot-folder, a name in `SENSITIVE_NAMES`, and what's in
 * `node_modules`, `scripts` or `bin`. Letter case doesn't matter.
 */
export const SENSITIVE_PATH = new RegExp(
  `(^|/)\\.|(^|/)(${SENSITIVE_NAMES.join('|')})$|(^|/)(node_modules|scripts|bin)/`,
  'i',
)

/** Tool kinds that change files: they must name every file, and none may be sensitive. */
const FILE_CHANGES = new Set(['edit', 'delete', 'move'])

/** Where agents that send no `locations` (like Muse) put a file's path in the tool's input. */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'notebook_path']

const isReject = (option: PermissionOption | undefined) =>
  option?.kind === 'reject_once' || option?.kind === 'reject_always'

/**
 * The agent itself says a person should decide: it put a reject option first (its way of
 * defaulting to No), it's Claude asking with no "always allow" (forced by the user's own
 * ask rules or Claude's safety checks), or it's a mode switch (Claude's plan approval).
 */
export function flaggedCaution(
  request: RequestPermissionRequest,
  agentId: AgentId,
  kind: string | null,
) {
  const { options } = request
  if (isReject(options[0])) return true
  if (agentId === 'claude' && !options.some((option) => option.kind === 'allow_always')) return true
  return kind === 'switch_mode'
}

/** The paths a request names: its `locations`, else the path fields of its raw input. */
export function requestPaths(request: RequestPermissionRequest): string[] {
  const { locations, rawInput } = request.toolCall
  if (locations?.length) return locations.map(({ path }) => path)
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return []
  const input = rawInput as Record<string, unknown>
  return PATH_FIELDS.flatMap((field) => {
    const value = input[field]
    return typeof value === 'string' && value !== '' ? [value] : []
  })
}

export interface ApprovalContext {
  agentId: AgentId
  /** The request's tool kind, or the tool call's when the request leaves it out */
  kind: string | null
  /**
   * Where `path` lands, relative to the project, when it's safely inside it (not through a
   * symlink, not in Gui's own data); otherwise null. A `write` must land on a file; a read
   * may name a folder.
   */
  place: (path: string, write: boolean) => Promise<string | null>
}

/**
 * The option Gui answers `request` with when it doesn't ask (allow once, never "always"),
 * or null when the user decides: the agent flagged the request, offers no "allow once",
 * names a path `place` can't put inside the project, or changes a sensitive file. A change
 * that names no files can't be placed, so it asks too. Commands, fetches and the like are
 * answered once those hold: Auto mode doesn't confine what they do.
 */
export async function autoApproval(
  request: RequestPermissionRequest,
  { agentId, kind, place }: ApprovalContext,
): Promise<string | null> {
  if (flaggedCaution(request, agentId, kind)) return null
  const allow = request.options.find((option) => option.kind === 'allow_once')
  if (!allow) return null
  const write = kind !== null && FILE_CHANGES.has(kind)
  const paths = requestPaths(request)
  if (write && paths.length === 0) return null
  const placed = await Promise.all(paths.map((path) => place(path, write)))
  const allowed = placed.every((rel) => rel !== null && !(write && SENSITIVE_PATH.test(rel)))
  return allowed ? allow.optionId : null
}
