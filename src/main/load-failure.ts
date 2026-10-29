import type { PreviewError } from '../shared/types'

/** `localhost:5173` for a web address; the whole address otherwise. */
function where(url: string) {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? parsed.host : url
  } catch {
    return url
  }
}

/**
 * A page that didn't load, in plain words. Chromium's code (`ERR_CONNECTION_REFUSED`) and
 * the address stay in `detail`, behind Details.
 */
export function loadFailure(code: string, url: string): PreviewError {
  const host = where(url)
  const detail = `${code} — ${url}`
  const say = (message: string) => ({ message, detail })
  switch (code) {
    case 'ERR_CONNECTION_REFUSED':
    case 'ERR_CONNECTION_FAILED':
    case 'ERR_ADDRESS_UNREACHABLE':
      return say(`Nothing is answering at ${host}. Your app may have stopped or moved.`)
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
    case 'ERR_EMPTY_RESPONSE':
      return say(`${host} stopped answering. Your app may have restarted or stopped.`)
    case 'ERR_TIMED_OUT':
    case 'ERR_CONNECTION_TIMED_OUT':
      return say(`${host} took too long to answer.`)
    case 'ERR_NAME_NOT_RESOLVED':
    case 'ERR_NAME_RESOLUTION_FAILED':
      return say(`Couldn't find ${host}. Check the address.`)
    case 'ERR_INTERNET_DISCONNECTED':
      return say('This Mac is offline.')
    case 'ERR_TOO_MANY_REDIRECTS':
      return say(`${host} keeps sending the preview somewhere else.`)
    case 'ERR_INVALID_URL':
    case 'ERR_UNSAFE_PORT':
    case 'ERR_DISALLOWED_URL_SCHEME':
      return say("The preview can't open that address.")
    case 'ERR_FILE_NOT_FOUND':
      return say("That file doesn't exist.")
  }
  if (code.startsWith('ERR_CERT_') || code.startsWith('ERR_SSL_'))
    return say(`Couldn't connect to ${host} securely.`)
  return say(`Couldn't load ${host}.`)
}

/** The preview's page process went away (Electron's `render-process-gone` reason). */
export function crashFailure(reason: string): PreviewError {
  const detail = `The preview's process ended: ${reason}`
  if (reason === 'oom' || reason === 'memory-eviction')
    return { message: 'The preview ran out of memory. Your app may be using too much.', detail }
  return { message: 'The preview stopped unexpectedly.', detail }
}
