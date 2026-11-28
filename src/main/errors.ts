import type { AgentFailure } from './analytics-queue'

/** An error with a plain message for everyone, and technical detail shown on request. */
export class DetailedError extends Error {
  constructor(
    message: string,
    readonly detail: string | null,
  ) {
    super(message)
  }
}

/**
 * An agent failure Gui tells apart (a CLI too old, its process quitting, a known turn error),
 * named for usage data by `failure`; the message is still what the user reads.
 */
export class AgentError extends DetailedError {
  constructor(
    message: string,
    detail: string | null,
    readonly failure: AgentFailure,
  ) {
    super(message, detail)
  }
}

/** Something Gui waited on ran out of time: an agent's check, or reading its version. */
export class TimeoutError extends DetailedError {}

export function describeError(error: unknown): { message: string; detail: string | null } {
  if (error instanceof DetailedError) return { message: error.message, detail: error.detail }
  return { message: error instanceof Error ? error.message : String(error), detail: null }
}

/** A page capture the page reloaded, navigated or crashed under (inspector.ts). */
export class CaptureInterrupted extends Error {
  constructor() {
    super('The page reloaded or navigated during the capture')
  }
}
