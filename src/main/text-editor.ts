import { IS_MAC, IS_WINDOWS } from '../shared/platform'
import { openPath } from './desktop-open'
import { findExecutable } from './executables'
import { execFile } from './process'
import { getShellEnv } from './shell-env'

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ ok: boolean; stdout: string }>((resolve) => {
    execFile(command, args, { env, timeout: 5000 }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout) }),
    )
  })
}

async function defaultTextEditor(env: NodeJS.ProcessEnv) {
  const xdgMime = await findExecutable('xdg-mime', env.PATH)
  if (!xdgMime) return null
  const { ok, stdout } = await run(xdgMime, ['query', 'default', 'text/plain'], env)
  const desktop = stdout.trim().split('\n')[0]?.trim()
  return ok && desktop ? desktop : null
}

export async function openAsText(path: string) {
  if (IS_MAC) {
    const opened = await run('/usr/bin/open', ['-t', path], process.env)
    if (!opened.ok) throw new Error(`Couldn't open ${path} in a text editor.`)
    return
  }
  // Windows has no xdg-mime or gtk-launch: the file's own default app, through ShellExecute.
  if (!IS_WINDOWS) {
    const env = await getShellEnv()
    const desktop = await defaultTextEditor(env)
    if (desktop) {
      for (const launcher of ['gtk-launch', 'gtk4-launch']) {
        const found = await findExecutable(launcher, env.PATH)
        if (found && (await run(found, [desktop, path], env)).ok) return
      }
    }
  }
  const error = await openPath(path)
  if (error) throw new Error(`Couldn't open ${path}: ${error}`)
}
