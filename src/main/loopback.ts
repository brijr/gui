const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

/** An http(s) URL on this machine: the only pages Grat treats as the user's own app. */
export function isLoopback(url: string | undefined) {
  if (!url) return false
  try {
    const { protocol, hostname } = new URL(url)
    return (
      /^https?:$/.test(protocol) &&
      (LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost'))
    )
  } catch {
    return false
  }
}
