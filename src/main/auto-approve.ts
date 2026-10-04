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

/**
 * Files that can change how code runs (build/tool config, dependencies, CI, hooks,
 * dotfiles) always need the user's approval, even when edits are otherwise automatic.
 */
export const SENSITIVE_PATH =
  /(^|\/)\.|(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]*\.lock|[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|Dockerfile|Makefile|[^/]*\.(sh|bash|zsh))$|(^|\/)(node_modules|scripts|bin)\//i

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
