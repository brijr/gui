/**
 * Running batch files (`npm.cmd`, `claude.cmd`, `pnpm.cmd`…) on Windows. Node refuses to
 * start a `.cmd` or `.bat` without a shell (EINVAL, since CVE-2024-27980), and turning on
 * `shell: true` would hand every argument to cmd.exe unquoted. process.ts runs batch files
 * here instead: through `cmd.exe /d /s /c "…"`, with every argument quoted for the program
 * and escaped for cmd.exe. Pure functions, so they're tested on every platform.
 *
 * cmd.exe reads the line twice: once for `/c`, and again when the batch file passes its
 * arguments on (`%*`, as every npm shim does). So arguments are escaped twice. Every `"`
 * is escaped too, so cmd.exe never sees a quoted stretch where `^` would be literal.
 * The scheme is cross-spawn's, which npm itself relies on.
 */

/** Characters cmd.exe treats specially outside quotes, escaped with `^`. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export const isBatchFile = (file: string) => /\.(cmd|bat)$/i.test(file)

/** One argument as the program (CommandLineToArgvW) reads it: quoted, `\` and `"` escaped. */
export function quoteArgument(arg: string) {
  // Backslashes before a quote, or before the closing quote, are doubled.
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  return `"${escaped}"`
}

/** `arg` quoted for the program and escaped for cmd.exe, once per time cmd.exe reads it. */
export function cmdArgument(arg: string, reads = 2) {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error("A batch file can't be given an argument with a line break in it.")
  }
  let text = quoteArgument(arg)
  for (let i = 0; i < reads; i++) text = text.replace(CMD_META, '^$1')
  return text
}

/**
 * The arguments to give `cmd.exe` (with `windowsVerbatimArguments`) so it runs the batch
 * file `file` with exactly `args`.
 */
export function batchCommandLine(file: string, args: readonly string[]): string[] {
  const command = file.replace(CMD_META, '^$1')
  const line = [command, ...args.map((arg) => cmdArgument(arg))].join(' ')
  return ['/d', '/s', '/c', `"${line}"`]
}

/** cmd.exe: %ComSpec%, else the one in System32. */
export function comSpec(env: NodeJS.ProcessEnv) {
  const value = envValue(env, 'ComSpec')
  if (value) return value
  return `${envValue(env, 'SystemRoot') ?? 'C:\\Windows'}\\System32\\cmd.exe`
}

/** A variable's value, its name matched without regard to case, as Windows does. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === upper) return value
  return undefined
}
