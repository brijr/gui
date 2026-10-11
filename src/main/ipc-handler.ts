import {
  type AllRequestArgs,
  type IpcReply,
  IpcRequestError,
  type LegacyChannel,
  type LegacyResult,
  type RequestArgs,
  type RequestChannel,
  type RequestResult,
} from '../shared/ipc-requests'

/** Authorization precedes validation and execution, including for malformed payloads. */
export function createRequestRegistrar<E>(
  transport: (channel: string, listener: (event: E, ...args: unknown[]) => unknown) => void,
) {
  return <C extends RequestChannel>(
    channel: C,
    boundary: { authorize: (event: E) => boolean; validate: (args: unknown[]) => boolean },
    handler: (event: E, ...args: RequestArgs<C>) => RequestResult<C> | Promise<RequestResult<C>>,
  ) => {
    transport(channel, async (event, ...args): Promise<IpcReply<RequestResult<C>>> => {
      try {
        if (!boundary.authorize(event))
          throw new IpcRequestError('forbidden', 'This action is available only from Gui’s own UI.')
        if (!boundary.validate(args))
          throw new IpcRequestError('invalid_request', 'That request is malformed.')
        // Runtime input is trusted only after the feature's boundary validator accepts it.
        return { ok: true, value: await handler(event, ...(args as RequestArgs<C>)) }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof IpcRequestError ? error.code : 'operation_failed',
            message: error instanceof Error ? error.message : 'Could not complete this action.',
          },
        }
      }
    })
  }
}

export const noRequestArgs = (args: unknown[]) => args.length === 0
export const stringRequestArgs = (count: number) => (args: unknown[]) =>
  args.length === count && args.every((arg) => typeof arg === 'string' && arg.length > 0)

/** Legacy wire format, with the same public argument/result types as the preload. */
export function createLegacyRegistrar<E>(
  transport: (channel: string, listener: (event: E, ...args: unknown[]) => unknown) => void,
) {
  return <C extends LegacyChannel>(
    channel: C,
    handler: (event: E, ...args: AllRequestArgs<C>) => LegacyResult<C> | Promise<LegacyResult<C>>,
  ) => transport(channel, (event, ...args) => handler(event, ...(args as AllRequestArgs<C>)))
}
