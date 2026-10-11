import { expect, test } from 'bun:test'
import { createRequestRegistrar, noRequestArgs } from '../src/main/ipc-handler'
import { invalidatesAccountSession } from '../src/shared/account'
import { Invoke } from '../src/shared/ipc'
import { createRequestInvoker, IpcRequestError } from '../src/shared/ipc-requests'

test('provider reconnect never clears the Gui session, including explicit coded 401s', () => {
  expect(invalidatesAccountSession(403, 'github_reconnect_required', '/repositories')).toBe(false)
  expect(invalidatesAccountSession(401, 'github_reconnect_required', '/repositories')).toBe(false)
  expect(invalidatesAccountSession(401, 'account_session_invalid', '/account')).toBe(true)
  expect(invalidatesAccountSession(401, undefined, '/account')).toBe(true)
  expect(invalidatesAccountSession(401, undefined, '/repositories')).toBe(false)
  expect(invalidatesAccountSession(401, 'account_session_invalid', '/repositories')).toBe(true)
  expect(invalidatesAccountSession(401, undefined, '/auth/token')).toBe(false)
})

type Sender = { role: 'chrome' | 'settings' | 'chat' | 'preview'; closed?: boolean }
function harness() {
  const handlers = new Map<string, (event: Sender, ...args: unknown[]) => unknown>()
  const register = createRequestRegistrar<Sender>((channel, listener) =>
    handlers.set(channel, listener),
  )
  const invoke = (sender: Sender) =>
    createRequestInvoker(async (channel, ...args) => handlers.get(channel)?.(sender, ...args))
  return { register, invoke, handlers }
}

test('typed request boundary permits chrome/settings and excludes agent content/preview', async () => {
  const { register, invoke } = harness()
  let calls = 0
  register(
    Invoke.accountState,
    {
      authorize: (sender) => sender.role === 'chrome' || sender.role === 'settings',
      validate: noRequestArgs,
    },
    () => {
      calls++
      return { configured: true, required: true, signedIn: true }
    },
  )
  for (const role of ['chrome', 'settings'] as const)
    expect((await invoke({ role })(Invoke.accountState)).signedIn).toBe(true)
  for (const role of ['chat', 'preview'] as const)
    await expect(invoke({ role })(Invoke.accountState)).rejects.toMatchObject({ code: 'forbidden' })
  expect(calls).toBe(2)
})

test('invalid payloads fail before execution; exceptions cross IPC with stable codes/messages', async () => {
  const { register, invoke, handlers } = harness()
  let calls = 0
  register(
    Invoke.accountUpdates,
    {
      authorize: (sender) => sender.role === 'settings',
      validate: (args) => args.length === 1 && typeof args[0] === 'boolean',
    },
    () => {
      calls++
      throw new Error('Service unavailable.')
    },
  )
  expect(await handlers.get(Invoke.accountUpdates)?.({ role: 'settings' }, 'yes')).toMatchObject({
    ok: false,
    error: { code: 'invalid_request' },
  })
  expect(await handlers.get(Invoke.accountUpdates)?.({ role: 'preview' }, 'yes')).toMatchObject({
    ok: false,
    error: { code: 'forbidden' },
  })
  expect(calls).toBe(0)
  await expect(invoke({ role: 'settings' })(Invoke.accountUpdates, true)).rejects.toMatchObject({
    code: 'operation_failed',
    message: 'Service unavailable.',
  })
  expect(calls).toBe(1)
})

test('missing project returns a predictable no_tab failure and successful void requests resolve', async () => {
  const { register, invoke } = harness()
  register(
    Invoke.openChat,
    {
      authorize: (sender) => sender.role === 'chrome' || sender.role === 'chat',
      validate: (args) => args.length === 1 && typeof args[0] === 'string',
    },
    (sender) => {
      if (sender.closed) throw new IpcRequestError('no_tab', 'Project closed.')
    },
  )
  await expect(invoke({ role: 'chrome' })(Invoke.openChat, 'id')).resolves.toBeUndefined()
  await expect(invoke({ role: 'chat', closed: true })(Invoke.openChat, 'id')).rejects.toMatchObject(
    {
      code: 'no_tab',
      message: 'Project closed.',
    },
  )
})
