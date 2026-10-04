/** An error with a plain message for everyone, and technical detail shown on request. */
export class DetailedError extends Error {
  constructor(
    message: string,
    readonly detail: string | null,
  ) {
    super(message)
  }
}

export function describeError(error: unknown): { message: string; detail: string | null } {
  if (error instanceof DetailedError) return { message: error.message, detail: error.detail }
  return { message: error instanceof Error ? error.message : String(error), detail: null }
}
