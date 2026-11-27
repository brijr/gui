import { describe, expect, test } from 'bun:test'
import {
  agentUnavailable,
  turnFailure,
  turnUsage,
  UPDATE_FAILURES,
  type UsageQueueOptions,
  type UsageReply,
  updateFailure,
  usageAgent,
  usageQueue,
} from '../src/main/analytics-queue'
import { AgentError, DetailedError } from '../src/main/errors'
import { MAX_QUEUED_USAGE_EVENTS, USAGE_BATCH } from '../src/shared/bounded'

const INSTALL = '0f8e2a4c-5b1d-4e7f-9a3b-6c2d8e0f1a2b'
const TURN = { agent: 'claude', outcome: 'done', picked: 'no', tools: 'no', mode: 'ask' } as const

interface Sent {
  installId: string
  events: { event: string; at: number; props?: Record<string, string> }[]
}

/** A queue whose sends are recorded; `reply` answers each one (or throws, as offline). */
function setup(
  overrides: Partial<UsageQueueOptions> & { reply?: (body: Sent) => UsageReply } = {},
) {
  const sent: Sent[] = []
  let enabled = true
  const { reply = () => ({ status: 204, json: async () => null }), ...rest } = overrides
  const queue = usageQueue({
    official: true,
    enabled: () => enabled,
    installId: () => INSTALL,
    post: async (body) => {
      const parsed = JSON.parse(body) as Sent
      sent.push(parsed)
      return reply(parsed)
    },
    now: () => 1_000,
    ...rest,
  })
  return {
    queue,
    sent,
    events: () => sent.flatMap((batch) => batch.events.map((e) => e.event)),
    setEnabled: (on: boolean) => {
      enabled = on
    },
  }
}

describe('usage queue', () => {
  test('a flush sends what was tracked, with the install ID, then nothing is left', async () => {
    const { queue, sent } = setup()
    queue.track('app_opened', { version: '1.0.0', os: 'darwin', osVersion: '26.1', arch: 'arm64' })
    queue.track('project_opened', { framework: 'next' })
    queue.track('turn_finished', TURN)
    await queue.flush()
    expect(sent).toEqual([
      {
        installId: INSTALL,
        events: [
          {
            event: 'app_opened',
            at: 1_000,
            props: { version: '1.0.0', os: 'darwin', osVersion: '26.1', arch: 'arm64' },
          },
          { event: 'project_opened', at: 1_000, props: { framework: 'next' } },
          { event: 'turn_finished', at: 1_000, props: TURN },
        ],
      },
    ])
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toHaveLength(1)
  })

  test('a build that is not an official release never keeps or sends anything', async () => {
    let asked = false
    const { queue, sent } = setup({
      official: false,
      installId: () => {
        asked = true
        return INSTALL
      },
    })
    queue.track('project_opened', { framework: 'next' })
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toEqual([])
    expect(asked).toBe(false)
  })

  test('the queue is bounded: past the cap, the oldest go', async () => {
    const { queue, sent } = setup()
    for (let i = 0; i < MAX_QUEUED_USAGE_EVENTS + 50; i++) {
      queue.track('agent_connected', { agent: `a${i}` })
    }
    expect(queue.size).toBe(MAX_QUEUED_USAGE_EVENTS)
    await queue.flush()
    const agents = sent.flatMap((batch) => batch.events.map((e) => e.props?.agent))
    expect(agents).toHaveLength(MAX_QUEUED_USAGE_EVENTS)
    expect(agents[0]).toBe('a50')
    // Sent a batch at a time.
    expect(sent.every((batch) => batch.events.length <= USAGE_BATCH)).toBe(true)
    expect(sent).toHaveLength(MAX_QUEUED_USAGE_EVENTS / USAGE_BATCH)
  })

  test('offline, events are kept for the next flush, within the cap', async () => {
    let online = false
    const { queue, sent, events } = setup({
      reply: () => {
        if (!online) throw new Error('offline')
        return { status: 204, json: async () => null }
      },
    })
    queue.track('project_opened', { framework: 'next' })
    queue.track('canvas_created')
    await queue.flush()
    expect(queue.size).toBe(2)
    for (let i = 0; i < MAX_QUEUED_USAGE_EVENTS; i++) queue.track('preview_opened')
    expect(queue.size).toBe(MAX_QUEUED_USAGE_EVENTS)
    online = true
    sent.length = 0
    await queue.flush()
    expect(queue.size).toBe(0)
    // The two kept from before were the oldest, so the cap dropped them.
    expect(events().filter((name) => name !== 'preview_opened')).toEqual([])
  })

  test('a server error keeps the batch; a refused batch is dropped', async () => {
    let status = 503
    const { queue } = setup({ reply: () => ({ status, json: async () => null }) })
    queue.track('project_opened', { framework: 'next' })
    await queue.flush()
    expect(queue.size).toBe(1)
    status = 400
    await queue.flush()
    expect(queue.size).toBe(0)
  })

  test('an event tracked while a send is under way is kept if the send fails', async () => {
    let release: () => void = () => {}
    const { queue } = setup({
      reply: () => {
        throw new Error('offline')
      },
      post: () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('offline'))
        }),
    })
    queue.track('project_opened', { framework: 'next' })
    const flushing = queue.flush()
    queue.track('canvas_created')
    release()
    await flushing
    expect(queue.size).toBe(2)
  })

  test('switched off: nothing is kept, and the queue clears', async () => {
    const { queue, sent, setEnabled } = setup()
    queue.track('project_opened', { framework: 'next' })
    queue.clear()
    expect(queue.size).toBe(0)
    setEnabled(false)
    queue.track('canvas_created')
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toEqual([])
  })

  test('switched off between tracking and the flush: nothing goes', async () => {
    const { queue, sent, setEnabled } = setup()
    queue.track('project_opened', { framework: 'next' })
    setEnabled(false)
    await queue.flush()
    expect(sent).toEqual([])
    expect(queue.size).toBe(0)
  })

  test('{ stop: true } stops sending and keeping for the rest of the launch', async () => {
    const { queue, sent } = setup({
      reply: () => ({ status: 200, json: async () => ({ stop: true }) }),
    })
    queue.track('project_opened', { framework: 'next' })
    await queue.flush()
    expect(sent).toHaveLength(1)
    expect(queue.stopped).toBe(true)
    queue.track('canvas_created')
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toHaveLength(1)
  })

  test('a flush that runs out of time keeps what it could not send', async () => {
    const { queue } = setup({
      post: (_body, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    })
    queue.track('project_opened', { framework: 'next' })
    const started = Date.now()
    await queue.flush(50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(queue.size).toBe(1)
  })

  test('two flushes at once send once', async () => {
    const { queue, sent } = setup()
    queue.track('project_opened', { framework: 'next' })
    await Promise.all([queue.flush(), queue.flush()])
    expect(sent).toHaveLength(1)
  })
})

describe('what a turn sends', () => {
  const plain = { picked: false, tools: false, autoApprove: false, ownPermissions: false }

  test('the agent, how it ended, and the provider only when it is a short name', () => {
    expect(turnUsage('claude', 'done', plain)).toEqual({
      agent: 'claude',
      outcome: 'done',
      picked: 'no',
      tools: 'no',
      mode: 'ask',
    })
    expect(turnUsage('codex', 'error', { ...plain, provider: 'grok' })).toMatchObject({
      agent: 'codex',
      outcome: 'failed',
      provider: 'grok',
    })
    const stopped = turnUsage('fx', 'cancelled', { ...plain, provider: 'https://example.com/v1' })
    expect(stopped).toMatchObject({ agent: 'fx', outcome: 'stopped' })
    expect(stopped).not.toHaveProperty('provider')
  })

  test('a picked element, a call to Gui\u2019s tools, and who decides what the agent may do', () => {
    expect(turnUsage('claude', 'done', { ...plain, picked: true, tools: true })).toMatchObject({
      picked: 'yes',
      tools: 'yes',
    })
    expect(turnUsage('claude', 'done', { ...plain, autoApprove: true }).mode).toBe('auto')
    // The agent's own settings decide, whatever Gui's Auto says.
    expect(turnUsage('claude', 'done', { ...plain, ownPermissions: true }).mode).toBe('own')
    expect(
      turnUsage('claude', 'done', { ...plain, autoApprove: true, ownPermissions: true }).mode,
    ).toBe('own')
  })

  test('a reason only when it failed: the failure the error carries, else other', () => {
    expect(turnUsage('claude', 'done', plain)).not.toHaveProperty('reason')
    expect(
      turnUsage('claude', 'cancelled', { ...plain, error: { failure: 'agent_quit' } }),
    ).not.toHaveProperty('reason')
    const failed = (error: unknown) => turnUsage('claude', 'error', { ...plain, error }).reason
    expect(failed(new AgentError('too long', 'detail', 'context_too_long'))).toBe(
      'context_too_long',
    )
    expect(failed(new AgentError('quit', null, 'agent_quit'))).toBe('agent_quit')
    expect(failed({ failure: 'signed_out' })).toBe('signed_out')
    expect(failed(new DetailedError('Could not start', 'a/path/in/the/detail'))).toBe('other')
    expect(failed(new Error('rate limit exceeded'))).toBe('other')
    expect(failed({ failure: 'something new' })).toBe('other')
    expect(failed(null)).toBe('other')
  })

  test('an agent from agents.json is custom, never its name', () => {
    expect(usageAgent('custom:My Secret Agent')).toBe('custom')
    expect(usageAgent('claude')).toBe('claude')
  })
})

describe('why an agent could not be used', () => {
  test('signed out and too old are named; anything else is error', () => {
    expect(turnFailure({ failure: 'signed_out' })).toBe('signed_out')
    expect(agentUnavailable({ failure: 'signed_out' })).toBe('signed_out')
    expect(agentUnavailable(new AgentError('old', null, 'too_old'))).toBe('too_old')
    expect(agentUnavailable(new AgentError('quit', null, 'agent_quit'))).toBe('error')
    expect(agentUnavailable(new Error("The agent didn't respond."))).toBe('error')
  })
})

/** An error as Node or builder-util-runtime makes one: a message and a `code`. */
function coded(message: string, code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

describe('why an update failed', () => {
  test('each reason, from an error like the one electron-updater or Squirrel.Mac raises', () => {
    const cases: [unknown, string][] = [
      // Node, through electron-updater's fs and sockets
      [coded('getaddrinfo ENOTFOUND usegui.com', 'ENOTFOUND'), 'offline'],
      [coded('read ECONNRESET', 'ECONNRESET'), 'dropped'],
      [coded('connect ETIMEDOUT 1.2.3.4:443', 'ETIMEDOUT'), 'timeout'],
      [
        coded("ENOSPC: no space left on device, write '/Users/x/Library/Caches'", 'ENOSPC'),
        'disk_full',
      ],
      [
        coded("EACCES: permission denied, open '/Users/x/Library/Caches/gui-updater'", 'EACCES'),
        'permission',
      ],
      [coded("EPERM: operation not permitted, rename '/Users/x/a'", 'EPERM'), 'permission'],
      [coded("EROFS: read-only file system, open '/Volumes/Gui/x'", 'EROFS'), 'read_only'],
      // builder-util-runtime
      [coded('HTTP error: Not Found', 'HTTP_ERROR_404', { statusCode: 404 }), 'http'],
      [{ statusCode: 503, message: 'Service unavailable' }, 'http'],
      [
        coded('sha512 checksum mismatch, expected abc, got def', 'ERR_CHECKSUM_MISMATCH'),
        'checksum',
      ],
      [
        new Error('checksum mismatch: expected abc but got def (X-Checksum-Sha2 header)'),
        'checksum',
      ],
      [new Error('Request timed out'), 'timeout'],
      // Electron's net (Chromium)
      [new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
      [new Error('net::ERR_NAME_NOT_RESOLVED'), 'offline'],
      [new Error('net::ERR_NETWORK_CHANGED'), 'dropped'],
      [new Error('net::ERR_CONNECTION_RESET'), 'dropped'],
      [new Error('net::ERR_TIMED_OUT'), 'timeout'],
      [new Error('net::ERR_FILE_NO_SPACE'), 'disk_full'],
      [new Error('net::ERR_ACCESS_DENIED'), 'permission'],
      // Squirrel.Mac, by message
      [
        new Error(
          'Code signature at URL file:///Users/x/Library/Caches/com.usegui.app.ShipIt/update.abc/Gui.app/ did not pass validation: code failed to satisfy specified code requirement(s)',
        ),
        'signature',
      ],
      [new Error('Could not get code signature for running application'), 'signature'],
      [
        new Error(
          'Cannot update while running on a read-only volume. The application is on a read-only volume. Please move the application and try again.',
        ),
        'read_only',
      ],
      [new Error('Failed to move bundle: Permission denied'), 'permission'],
      [new Error('The operation couldn\u2019t be completed. No space left on device'), 'disk_full'],
    ]
    for (const [error, reason] of cases)
      expect([error, updateFailure(error)]).toEqual([error, reason])
    const named = new Set(cases.map(([, reason]) => reason))
    expect(UPDATE_FAILURES.filter((reason) => !named.has(reason))).toEqual(['other'])
  })

  test('anything it cannot tell apart is other', () => {
    expect(updateFailure(new Error('Something broke at /Users/x/app'))).toBe('other')
    expect(updateFailure(new Error('net::ERR_CERT_DATE_INVALID'))).toBe('other')
    expect(updateFailure(coded('ZIP file not provided', 'ERR_UPDATER_ZIP_FILE_NOT_FOUND'))).toBe(
      'other',
    )
    expect(updateFailure(coded('x', 'ENOENT'))).toBe('other')
    expect(updateFailure({ statusCode: 304 })).toBe('other')
    expect(updateFailure('net::ERR_INTERNET_DISCONNECTED')).toBe('other')
    expect(updateFailure(null)).toBe('other')
    expect(updateFailure(undefined)).toBe('other')
  })
})
