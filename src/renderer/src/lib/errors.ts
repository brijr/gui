/** Main-process errors arrive as "Error invoking remote method 'x': Error: …". */
export function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
