const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "12s", "2m 5s", "1h 3m"; null under a second or when it isn't known. */
export function duration(ms: number | null) {
  if (ms === null) return null
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return null
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "5 minutes ago", "yesterday": when a chat's last message was sent. */
export function timeAgo(at: number) {
  const seconds = (Date.now() - at) / 1000
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return RELATIVE.format(-Math.floor(seconds / size), unit)
  }
  return 'just now'
}
