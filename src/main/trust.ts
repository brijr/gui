import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow, dialog, type MessageBoxOptions } from 'electron'

/**
 * Projects whose dev script the user has agreed to run. Opening a folder must not
 * execute its package.json scripts until the user has seen and accepted them.
 */
const file = () => join(app.getPath('userData'), 'trusted-projects.json')

async function load(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

const canonical = (root: string) => realpath(root).catch(() => root)

export async function isTrusted(root: string) {
  return (await load()).includes(await canonical(root))
}

export function listTrusted() {
  return load()
}

/** The project's dev script will ask again before it runs. */
export async function untrust(root: string) {
  const trusted = await load()
  await writeFile(
    file(),
    JSON.stringify(
      trusted.filter((path) => path !== root),
      null,
      2,
    ),
  )
}

export async function trust(root: string) {
  const path = await canonical(root)
  const trusted = await load()
  if (trusted.includes(path)) return
  await writeFile(file(), JSON.stringify([...trusted, path], null, 2))
}

/**
 * The trust prompt, as a sheet on `parent` when there is one. Its first button agrees,
 * which trusts the project from then on; `options` names the buttons and may move the
 * default. Project text in it must go through `promptText`/`promptName`.
 */
export async function askToTrust(
  root: string,
  options: MessageBoxOptions,
  parent: BrowserWindow | null,
) {
  const prompt: MessageBoxOptions = { type: 'question', defaultId: 0, cancelId: 1, ...options }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, prompt)
      : await dialog.showMessageBox(prompt)
  if (response !== 0) return false
  // If it can't be saved, this run still goes ahead and the next one asks again.
  await trust(root).catch((error: unknown) => {
    console.error('[grat] failed to trust the project', error)
  })
  return true
}

/** Script text longer than this is cut off in the trust prompt. */
const MAX_PROMPT_TEXT = 300

/**
 * Controls (newline aside) and bidi overrides, isolates and marks: they can make a script
 * in the trust prompt read as something other than what runs.
 */
function isHidden(code: number) {
  return (
    (code < 0x20 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/** Newline and the Unicode line and paragraph separators, which display as line breaks. */
const isBreak = (code: number) => code === 0x0a || code === 0x2028 || code === 0x2029

/**
 * Project text (a script, a folder name) as the trust prompt shows it. The project wrote it,
 * so hidden characters go, blank lines and runs of spaces collapse (padding can't push the
 * rest out of view), and it's cut off at `max` characters with "…".
 */
export function promptText(text: string, max = MAX_PROMPT_TEXT, oneLine = false): string {
  let visible = ''
  for (const char of text.replace(/\r\n?/g, '\n')) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x09 || (oneLine && isBreak(code))) visible += ' '
    else if (isBreak(code)) visible += '\n'
    else if (!isHidden(code)) visible += char
  }
  const lines = visible.split('\n').map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
  const kept = lines.filter((line, i) => line !== '' || (i > 0 && lines[i - 1] !== ''))
  const chars = Array.from(kept.join('\n').trim())
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : chars.join('')
}

/** `promptText` on one line, for a name inside a sentence. */
export const promptName = (text: string) => promptText(text, 80, true)
