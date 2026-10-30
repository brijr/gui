import type { IpcMainInvokeEvent } from 'electron'
import { Invoke } from '../shared/ipc'
import {
  accountState,
  cancelSignIn,
  getAccount,
  setAccountUpdates,
  signIn,
  signOut,
} from './account'
import { connectGitHub, disconnectGitHub, getGitHub, manageGitHub } from './github'
import { type createRequestRegistrar, noRequestArgs } from './ipc-handler'

/** Account/provider requests share the trusted application-UI boundary, never agent content. */
export function registerAccountIpc(
  handleRequest: ReturnType<typeof createRequestRegistrar<IpcMainInvokeEvent>>,
  options: {
    authorize: (event: IpcMainInvokeEvent) => boolean
    clone: (event: IpcMainInvokeEvent, id: number) => Promise<void>
  },
) {
  const appRequest = { authorize: options.authorize, validate: noRequestArgs }
  handleRequest(Invoke.accountState, appRequest, () => accountState())
  handleRequest(Invoke.accountProfile, appRequest, () => getAccount())
  handleRequest(Invoke.accountSignIn, appRequest, () => signIn())
  handleRequest(Invoke.accountCancel, appRequest, () => cancelSignIn())
  handleRequest(Invoke.accountSignOut, appRequest, () => signOut())
  handleRequest(
    Invoke.accountUpdates,
    {
      authorize: options.authorize,
      validate: (args) => args.length === 1 && typeof args[0] === 'boolean',
    },
    (_event, updates) => setAccountUpdates(updates),
  )
  handleRequest(
    Invoke.githubState,
    {
      authorize: options.authorize,
      validate: (args) => args.length === 0 || (args.length === 1 && typeof args[0] === 'boolean'),
    },
    (_event, refresh) => getGitHub(refresh),
  )
  handleRequest(Invoke.githubConnect, appRequest, () => connectGitHub())
  handleRequest(Invoke.githubDisconnect, appRequest, () => disconnectGitHub())
  handleRequest(Invoke.githubManage, appRequest, () => manageGitHub())
  handleRequest(
    Invoke.githubClone,
    {
      authorize: options.authorize,
      validate: (args) =>
        args.length === 1 &&
        typeof args[0] === 'number' &&
        Number.isSafeInteger(args[0]) &&
        args[0] > 0,
    },
    options.clone,
  )
}
