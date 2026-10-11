import {
  createLegacyRegistrar,
  createRequestRegistrar,
  noRequestArgs,
} from '../src/main/ipc-handler'
import { Invoke } from '../src/shared/ipc'
import { createLegacyInvoker, createRequestInvoker } from '../src/shared/ipc-requests'

/** Compiled by the normal typecheck; these failures must remain compile-time errors. */
export function checkIpcContracts() {
  const invoke = createRequestInvoker(async () => undefined)
  const legacyInvoke = createLegacyInvoker(async () => undefined)
  const legacyRegister = createLegacyRegistrar<unknown>(() => undefined)
  const register = createRequestRegistrar<unknown>(() => undefined)
  // @ts-expect-error Legacy request wrappers also enforce argument types.
  void legacyInvoke(Invoke.getTerminal, 42)
  // @ts-expect-error Legacy handler replies cannot silently drift from GuiApi.
  legacyRegister(Invoke.getChat, () => false)
  // @ts-expect-error Request parameters come from the public Gui API.
  void invoke(Invoke.accountUpdates, 'yes')
  // @ts-expect-error Channels without parameters cannot accept extra data.
  void invoke(Invoke.accountState, true)
  // @ts-expect-error Main handlers must return the public Gui API result.
  register(Invoke.accountState, { authorize: () => true, validate: noRequestArgs }, () => false)
}
