import { type BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { canonical, isStrings, rootStore } from './root-store'

/**
 * Projects whose dev script the user has agreed to run. Opening a folder must not
 * execute its package.json scripts until the user has seen and accepted them.
 */
const projects = rootStore(
  'trusted-projects.json',
  (value): value is string => typeof value === 'string',
  true,
)

export async function isTrusted(root: string) {
  return (await projects.load()).includes(await canonical(root))
}

export async function listTrusted() {
  return projects.load()
}

/** The project's dev script will ask again before it runs. */
export async function untrust(root: string) {
  const path = await canonical(root)
  await projects.update((trusted) => trusted.filter((p) => p !== root && p !== path))
  await updateScripts(({ [path]: _gone, [root]: _given, ...rest }) => rest)
}

/**
 * What the user agreed to run in a trusted project, so a script that changes later (a
 * `git pull`, an edit outside Gui) is shown again before it runs. By project root (real
 * path), in Gui's data. A project trusted before Gui kept these has none, and starts with
 * what it runs then.
 */
export interface TrustedScripts {
  /**
   * What each app runs (`startKey`: the command, its folder and its script), by the app's
   * folder ('.' for the root): a monorepo's apps are agreed to one at a time
   */
  starts: Record<string, string>
  /**
   * Install lifecycle scripts (preinstall, install, postinstall, prepare) of the root and
   * the app's folder, by "name" or "folder: name"; null until an install prompt showed them
   */
  installs: Record<string, string> | null
}

const isScripts = (value: unknown): value is TrustedScripts => {
  if (!value || typeof value !== 'object') return false
  const { starts, installs } = value as Record<string, unknown>
  return isStrings(starts) && (installs === null || isStrings(installs))
}

const { load: loadScripts, update: updateScripts } = rootStore('trusted-scripts.json', isScripts)

/** The scripts the user last agreed to run in the project; null when none are kept. */
export async function trustedScripts(root: string): Promise<TrustedScripts | null> {
  return (await loadScripts())[await canonical(root)] ?? null
}

export async function recordTrustedScripts(root: string, scripts: TrustedScripts) {
  const path = await canonical(root)
  await updateScripts((saved) => ({ ...saved, [path]: scripts }))
}

export async function trust(root: string) {
  const path = await canonical(root)
  await projects.update((trusted) => (trusted.includes(path) ? trusted : [...trusted, path]))
}

/**
 * The trust prompt, as a sheet on `parent` when there is one. Its first button agrees,
 * which trusts the project from then on, and keeps `scripts` as what was agreed to run;
 * `options` names the buttons and may move the default. Project text in it must go
 * through `promptText`/`promptName`.
 */
export async function askToTrust(
  root: string,
  options: MessageBoxOptions,
  parent: BrowserWindow | null,
  scripts: TrustedScripts | null = null,
) {
  const prompt: MessageBoxOptions = { type: 'question', defaultId: 0, cancelId: 1, ...options }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, prompt)
      : await dialog.showMessageBox(prompt)
  if (response !== 0) return false
  await agreeTo(root, scripts)
  return true
}

/**
 * The user agreed (on the setup card, or in the prompt): the project is trusted from then on,
 * and `scripts` kept as what they agreed to run. If it can't be saved, this run still goes
 * ahead and the next one asks again.
 */
export async function agreeTo(root: string, scripts: TrustedScripts | null) {
  await Promise.all([trust(root), scripts && recordTrustedScripts(root, scripts)]).catch(
    (error: unknown) => console.error('[gui] failed to trust the project', error),
  )
}

/** Script text longer than this is cut off in the trust prompt, which then says so. */
const MAX_PROMPT_TEXT = 300
/** A name inside a sentence of the prompt is cut off here. */
const MAX_PROMPT_NAME = 80

/**
 * Spaces of every width (no-break, em, ideographic and the rest), the tab and the blank
 * Braille cell. Each is shown as one space, so a run of any of them collapses like a run of
 * spaces: padding can't push the rest out of view.
 */
const SPACE = /[\t\p{Zs}\u2800]/u

/**
 * Characters that draw nothing, or change the order the rest is drawn in: controls, format
 * characters (bidi overrides, isolates and marks, zero-width spaces and joiners, tags) and
 * whatever else Unicode says to draw nothing for (variation selectors, fillers). They can
 * make a script in the trust prompt read as something other than what runs, and pad it
 * without showing.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u

/** Newline and the Unicode line and paragraph separators, which display as line breaks. */
const isBreak = (char: string) => char === '\n' || char === '\u2028' || char === '\u2029'

/**
 * The characters of project text (a script, a folder name) as the trust prompt shows them.
 * The project wrote it, so hidden characters go, every kind of space is a space, and blank
 * lines and runs of spaces collapse.
 */
function shownChars(text: string, oneLine: boolean): string[] {
  let visible = ''
  for (const char of text.replace(/\r\n?/g, '\n')) {
    if (isBreak(char)) visible += oneLine ? ' ' : '\n'
    else if (SPACE.test(char)) visible += ' '
    else if (!HIDDEN.test(char)) visible += char
  }
  const lines = visible.split('\n').map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
  const kept = lines.filter((line, i) => line !== '' || (i > 0 && lines[i - 1] !== ''))
  return Array.from(kept.join('\n').trim())
}

const cutAt = (chars: string[], max: number) => `${chars.slice(0, max).join('').trimEnd()}…`

/**
 * A script as the trust prompt shows it (see `shownChars`). Past `max` characters it is cut
 * off, and a sentence under it says how much isn't shown and that the whole script is in
 * `file`, so the end of a long script is never left out without a word. `file` goes into
 * the prompt as given: pass project text through `promptName` first.
 */
export function promptText(text: string, max = MAX_PROMPT_TEXT, file = 'package.json'): string {
  const chars = shownChars(text, false)
  if (chars.length <= max) return chars.join('')
  const shown = cutAt(chars, max)
  // Counted in characters, as the limit is: `shown` ends with the "…".
  const more = chars.length - (Array.from(shown).length - 1)
  const left = `${more.toLocaleString('en-US')} more ${more === 1 ? 'character is' : 'characters are'}`
  return `${shown}\n\nThis script is cut short: ${left} not shown. Read all of it in ${file} before you start it.`
}

/** Project text on one line, for a name inside a sentence: cut off at 80 characters with "…". */
export function promptName(text: string): string {
  const chars = shownChars(text, true)
  return chars.length > MAX_PROMPT_NAME ? cutAt(chars, MAX_PROMPT_NAME) : chars.join('')
}
