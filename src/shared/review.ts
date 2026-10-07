import type { ProposalPull, ReviewComment } from './types'

/**
 * The messages Gui writes to the agent about the pull request, and the commit titles they
 * become: the agent's message is no title for a commit (ship.ts suggests titles from prompts).
 */

const REVIEW_START = /^Address (?:this review comment|these review comments) on the pull request/

/** The message the agent gets for one or more reviewer comments. */
export function fixPrompt(pull: ProposalPull, comments: ReviewComment[]): string {
  const quoted = comments
    .map((comment) => {
      const where = comment.path
        ? ` on ${comment.path}${comment.line ? ` line ${comment.line}` : ''}`
        : ''
      const body = comment.body
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      return `@${comment.author}${where}:\n${body}`
    })
    .join('\n\n')
  const what = comments.length === 1 ? 'this review comment' : 'these review comments'
  return `Address ${what} on the pull request “${pull.title}”:

${quoted}

Make the changes asked for. If a comment is a question rather than a request, answer it here instead of changing code.`
}

/** What a review-fix message (`fixPrompt`) is called in a commit: its first quoted line. */
export function reviewTitle(prompt: string): string | null {
  if (!REVIEW_START.test(prompt)) return null
  const quote = /^> (.+)$/m.exec(prompt)?.[1]?.trim()
  return quote ? `Review: ${quote}` : 'Address review comments'
}
