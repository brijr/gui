/** Branch naming shared by shipping and worktrees; pure, so tests load it without Electron. */

/**
 * Branches a team shares or deploys from. Shipping from one starts a new branch, so
 * Gui never commits straight onto them unless the user explicitly picks the branch
 * they're already on.
 */
export const SHARED_BRANCHES = new Set([
  'main',
  'master',
  'develop',
  'development',
  'dev',
  'staging',
  'stage',
  'production',
  'prod',
  'trunk',
  'gh-pages',
])

/** Lowercase words joined by dashes, at most 40 characters. */
export function slugify(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > 40) break
    slug = next
  }
  return slug || words[0]?.slice(0, 40) || 'changes'
}
