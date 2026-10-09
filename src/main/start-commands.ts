import { readFile, realpath, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { app } from 'electron'
import type { StartCommand, StartCommandInput } from '../shared/types'
import { writeFileAtomic } from './atomic-file'
import { isLoopback } from './loopback'
import { type DetectedProject, detectProject, realRelative } from './project'

/**
 * Start commands set in Gui, by project root: how to start a project whose app Gui can't
 * find or starts wrong (another script, another folder, a command outside package.json).
 * In Gui's data rather than the project, so a project can't set its own.
 */
const file = () => join(app.getPath('userData'), 'start-commands.json')

const MAX_COMMAND = 2000

type Saved = Record<string, StartCommand>

const isStartCommand = (value: unknown): value is StartCommand => {
  if (!value || typeof value !== 'object') return false
  const { command, dir, url } = value as Record<string, unknown>
  return (
    typeof command === 'string' &&
    (dir === null || typeof dir === 'string') &&
    (url === null || typeof url === 'string')
  )
}

async function load(): Promise<Saved> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, StartCommand] =>
        isStartCommand(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

const canonical = (root: string) => realpath(root).catch(() => root)

let pendingWrite: Promise<unknown> = Promise.resolve()

/** One change at a time, each on what the last one wrote, so none is lost. */
function update(change: (saved: Saved) => Saved) {
  const task = pendingWrite.then(async () => {
    await writeFileAtomic(file(), JSON.stringify(change(await load()), null, 2))
  })
  pendingWrite = task.catch(() => undefined)
  return task
}

export async function getStartCommand(root: string): Promise<StartCommand | null> {
  return (await load())[await canonical(root)] ?? null
}

export async function listStartCommands() {
  return Object.entries(await load()).map(([root, start]) => ({ root, start }))
}

/** Saves `start` for the project; null goes back to what Gui detects. */
export async function saveStartCommand(root: string, start: StartCommand | null) {
  const path = await canonical(root)
  await update((saved) => {
    const { [path]: _old, [root]: _given, ...rest } = saved
    return start ? { ...rest, [path]: start } : rest
  })
}

/**
 * A start command as it's saved, or an error saying what's wrong with it. The folder must
 * really be in the project (a symlink on the way could lead out of it), and the address
 * must be on this Mac: the preview only shows the user's own app.
 */
export async function validateStartCommand(
  root: string,
  input: StartCommandInput,
): Promise<StartCommand> {
  const command = input.command.trim()
  if (!command) throw new Error('Enter the command that starts your app.')
  if (command.length > MAX_COMMAND) throw new Error('That command is too long.')
  if (/[\0\r\n]/.test(command)) throw new Error('Put the command on one line.')

  let dir: string | null = null
  const given = (input.dir ?? '')
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
  if (given && given !== '.') {
    const rel = await realRelative(root, join(root, given))
    const isDir = await stat(join(root, given)).then(
      (info) => info.isDirectory(),
      () => false,
    )
    if (rel === null || !isDir) throw new Error(`${given} isn't a folder in this project.`)
    dir = rel ? rel.split(/[\\/]/).join(posix.sep) : null
  }

  let url: string | null = null
  const address = (input.url ?? '').trim()
  if (address) {
    const withScheme = /^[a-z][\w+.-]*:\/\//i.test(address) ? address : `http://${address}`
    if (!isLoopback(withScheme)) {
      throw new Error('The address must be on this Mac, like http://localhost:3000.')
    }
    url = new URL(withScheme).toString()
  }
  return { command, dir, url }
}

/** What to run in the project: the start command set in Gui, or else what Gui detects. */
export async function resolveProject(
  root: string,
  preferredApp: string | null,
): Promise<DetectedProject> {
  const [detected, custom] = await Promise.all([
    detectProject(root, preferredApp),
    getStartCommand(root),
  ])
  if (!custom) return detected
  return {
    project: {
      ...detected.project,
      devCommand: custom.command,
      devScript: custom.command,
      appDir: custom.dir,
      custom,
    },
    apps: detected.apps,
    // The command says what to run: there's nothing to choose.
    choosing: false,
  }
}
