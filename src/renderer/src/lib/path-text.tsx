import { cn } from './cn'

/** The path with the home folder shown as ~. */
export function displayPath(path: string, home?: string | null) {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

interface PathTextProps {
  path: string
  /** The user's home folder (from main's state), shown as ~ */
  home?: string | null
  /** Tooltip; the full path by default */
  title?: string
  /** Size and color; it inherits both */
  className?: string
}

/**
 * A path in monospace that truncates in the middle, keeping its last segment, which is the
 * part that tells paths apart: "~/Projects/…/northwind-web". Use it wherever a path (or
 * branch, or command) is shown. It's a flex row, so give its parent room or a min-w-0.
 */
export function PathText({ path, home, title, className }: PathTextProps) {
  const shown = displayPath(path, home)
  // The last segment keeps its leading slash (and a trailing one), so a cut head still reads
  // as a path: "~/Proj…/web".
  const cut = shown.lastIndexOf('/', shown.length - 2)
  const head = cut > 0 ? shown.slice(0, cut) : ''
  const tail = cut > 0 ? shown.slice(cut) : shown
  return (
    <span title={title ?? path} className={cn('flex min-w-0 font-mono', className)}>
      {/* Read as one string; the two halves are only there to truncate in the middle. */}
      <span className="sr-only">{shown}</span>
      {head && (
        <span aria-hidden="true" className="min-w-0 truncate">
          {head}
        </span>
      )}
      {/* Whole unless it alone is too long; it leaves the head room for an ellipsis. */}
      <span
        aria-hidden="true"
        className={cn('shrink-0 truncate', head ? 'max-w-11/12' : 'max-w-full')}
      >
        {tail}
      </span>
    </span>
  )
}
