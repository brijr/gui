import { type GuiApi, Invoke } from './ipc'

/** Migrate by feature; legacy handlers retain their existing wire format. */
type Contract<M extends keyof GuiApi> = GuiApi[M] extends (...args: infer A) => Promise<infer R>
  ? { args: A; result: R }
  : never

export interface AllIpcRequests {
  [Invoke.getSymbols]: Contract<'getSymbols'>
  [Invoke.getState]: Contract<'getState'>
  [Invoke.getLogs]: Contract<'getLogs'>
  [Invoke.getTerminal]: Contract<'getTerminal'>
  [Invoke.getChat]: Contract<'getChat'>
  [Invoke.openProject]: Contract<'openProject'>
  [Invoke.openRecent]: Contract<'openRecent'>
  [Invoke.removeRecent]: Contract<'removeRecent'>
  [Invoke.archiveRecentChat]: Contract<'archiveRecentChat'>
  [Invoke.cloneProject]: Contract<'cloneProject'>
  [Invoke.accountState]: Contract<'getAccount'>
  [Invoke.accountProfile]: Contract<'getAccountProfile'>
  [Invoke.accountSignIn]: Contract<'accountSignIn'>
  [Invoke.accountCancel]: Contract<'cancelAccountSignIn'>
  [Invoke.accountSignOut]: Contract<'signOutAccount'>
  [Invoke.accountUpdates]: Contract<'setAccountUpdates'>
  [Invoke.githubState]: Contract<'getGitHub'>
  [Invoke.githubConnect]: Contract<'connectGitHub'>
  [Invoke.githubDisconnect]: Contract<'disconnectGitHub'>
  [Invoke.githubManage]: Contract<'manageGitHub'>
  [Invoke.githubClone]: Contract<'cloneGitHub'>
  [Invoke.githubCreate]: Contract<'createGitHub'>
  [Invoke.newProject]: Contract<'newProject'>
  [Invoke.send]: Contract<'send'>
  [Invoke.listVersions]: Contract<'getVersions'>
  [Invoke.saveVersion]: Contract<'saveVersion'>
  [Invoke.restoreVersion]: Contract<'restoreVersion'>
  [Invoke.restoreTurn]: Contract<'restoreTurn'>
  [Invoke.redo]: Contract<'redo'>
  [Invoke.fixProblems]: Contract<'fixProblems'>
  [Invoke.fixStartup]: Contract<'fixStartup'>
  [Invoke.setStartCommand]: Contract<'setStartCommand'>
  [Invoke.chatSignIn]: Contract<'signInAgain'>
  [Invoke.chatSetUpAgent]: Contract<'setUpChatAgent'>
  [Invoke.loadCommands]: Contract<'loadCommands'>
  [Invoke.listChats]: Contract<'listChats'>
  [Invoke.openChat]: Contract<'openChat'>
  [Invoke.renameChat]: Contract<'renameChat'>
  [Invoke.deleteChat]: Contract<'deleteChat'>
  [Invoke.signIn]: Contract<'signIn'>
  [Invoke.installAgent]: Contract<'installAgent'>
  [Invoke.connectAgent]: Contract<'connectAgent'>
  [Invoke.shipInfo]: Contract<'getShipInfo'>
  [Invoke.takeScreenshot]: Contract<'takeScreenshot'>
  [Invoke.showToolbarMenu]: Contract<'showToolbarMenu'>
  [Invoke.startRecording]: Contract<'startRecording'>
  [Invoke.recordingFrame]: Contract<'saveRecordingFrame'>
  [Invoke.recordingVideo]: Contract<'saveRecordingVideo'>
  [Invoke.finishRecording]: Contract<'finishRecording'>
  [Invoke.prepareNarration]: Contract<'prepareNarration'>
  [Invoke.discardRecording]: Contract<'discardRecording'>
  [Invoke.ship]: Contract<'ship'>
  [Invoke.share]: Contract<'share'>
  [Invoke.stayOnBranch]: Contract<'stayOnBranch'>
  [Invoke.trustProject]: Contract<'trustProject'>
  [Invoke.setGitIdentity]: Contract<'setGitIdentity'>
  [Invoke.openGitHubSettings]: Contract<'openGitHubSettings'>
  [Invoke.sourceControl]: Contract<'sourceControl'>
  [Invoke.getProposal]: Contract<'getProposal'>
  [Invoke.startFresh]: Contract<'startFresh'>
  [Invoke.bringInLatest]: Contract<'bringInLatest'>
  [Invoke.finishMerge]: Contract<'finishMerge'>
  [Invoke.cancelMerge]: Contract<'cancelMerge'>
  [Invoke.resolveConflicts]: Contract<'resolveConflicts'>
  [Invoke.getSettings]: Contract<'getSettings'>
  [Invoke.saveCustomAgent]: Contract<'saveCustomAgent'>
  [Invoke.deleteCustomAgent]: Contract<'deleteCustomAgent'>
  [Invoke.untrustProject]: Contract<'untrustProject'>
  [Invoke.resetStartCommand]: Contract<'resetStartCommand'>
  [Invoke.askAboutBranch]: Contract<'askAboutBranch'>
  [Invoke.createWorktree]: Contract<'createWorktree'>
  [Invoke.removeWorktree]: Contract<'removeWorktree'>
  [Invoke.openWorktree]: Contract<'openWorktree'>
  [Invoke.clearRecent]: Contract<'clearRecent'>
  [Invoke.clearStorage]: Contract<'clearStorage'>
  [Invoke.boardChatCover]: Contract<'boardChatCover'>
}

export interface IpcRequests {
  [Invoke.accountState]: Contract<'getAccount'>
  [Invoke.accountProfile]: Contract<'getAccountProfile'>
  [Invoke.accountSignIn]: Contract<'accountSignIn'>
  [Invoke.accountCancel]: Contract<'cancelAccountSignIn'>
  [Invoke.accountSignOut]: Contract<'signOutAccount'>
  [Invoke.accountUpdates]: Contract<'setAccountUpdates'>
  [Invoke.githubState]: Contract<'getGitHub'>
  [Invoke.githubConnect]: Contract<'connectGitHub'>
  [Invoke.githubDisconnect]: Contract<'disconnectGitHub'>
  [Invoke.githubManage]: Contract<'manageGitHub'>
  [Invoke.githubClone]: Contract<'cloneGitHub'>
  [Invoke.githubCreate]: Contract<'createGitHub'>
  [Invoke.listChats]: Contract<'listChats'>
  [Invoke.openChat]: Contract<'openChat'>
  [Invoke.renameChat]: Contract<'renameChat'>
  [Invoke.deleteChat]: Contract<'deleteChat'>
}
export type RequestChannel = keyof IpcRequests
export type RequestArgs<C extends RequestChannel> = IpcRequests[C]['args']
export type RequestResult<C extends RequestChannel> = IpcRequests[C]['result']
export type IpcFailureCode = 'forbidden' | 'invalid_request' | 'no_tab' | 'operation_failed'
export type IpcReply<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: IpcFailureCode; message: string } }

export class IpcRequestError extends Error {
  constructor(
    public readonly code: IpcFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'IpcRequestError'
  }
}

/** The only cast is at the Electron transport boundary, shared by all migrated callers. */
export function createRequestInvoker(
  transport: (channel: string, ...args: unknown[]) => Promise<unknown>,
) {
  return async <C extends RequestChannel>(
    channel: C,
    ...args: RequestArgs<C>
  ): Promise<RequestResult<C>> => {
    const reply = (await transport(channel, ...args)) as IpcReply<RequestResult<C>>
    if (!reply.ok) throw new IpcRequestError(reply.error.code, reply.error.message)
    return reply.value
  }
}

/** Existing wire replies remain stable while their handlers migrate feature by feature. */
export type LegacyErrorChannel =
  | typeof Invoke.archiveRecentChat
  | typeof Invoke.cloneProject
  | typeof Invoke.newProject
  | typeof Invoke.setStartCommand
  | typeof Invoke.startFresh
  | typeof Invoke.bringInLatest
  | typeof Invoke.stayOnBranch
  | typeof Invoke.setGitIdentity
  | typeof Invoke.finishMerge
  | typeof Invoke.cancelMerge
  | typeof Invoke.resolveConflicts
  | typeof Invoke.createWorktree
  | typeof Invoke.removeWorktree
  | typeof Invoke.openWorktree
  | typeof Invoke.saveCustomAgent
  | typeof Invoke.deleteCustomAgent
export type LegacyChannel = Exclude<keyof AllIpcRequests, RequestChannel>
export type AllRequestArgs<C extends keyof AllIpcRequests> = AllIpcRequests[C]['args']
export type LegacyResult<C extends LegacyChannel> = C extends LegacyErrorChannel
  ? { error: string | null }
  : AllIpcRequests[C]['result']

export function createLegacyInvoker(
  transport: (channel: string, ...args: unknown[]) => Promise<unknown>,
) {
  return async <C extends LegacyChannel>(
    channel: C,
    ...args: AllRequestArgs<C>
  ): Promise<LegacyResult<C>> => (await transport(channel, ...args)) as LegacyResult<C>
}

// Adding an Invoke channel without its GuiApi contract must fail the standard typecheck.
type AssertComplete<T extends never> = T
export type IpcContractCoverage = AssertComplete<
  Exclude<(typeof Invoke)[keyof typeof Invoke], keyof AllIpcRequests>
>
