import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { type EditScope, isOutside, projectEditPath } from '../src/main/chat-paths'
import { execFileSync } from '../src/main/process'

// Where a path the agent names lands, as chat.ts asks before it answers a permission request
// without the user: `projectEditPath(path, scope)` for a change, and with `folders` for a
// read or a search. A relative path (returned) is approved; null asks the user.
//
// Everything lives in one temp folder, laid out like this:
//
//   proj/                      the project
//     src/app.tsx              an ordinary file
//     src/components/          a folder
//     package.json
//     gui-data/prefs.json      stands in for Gui's own data, when a project contains it
//     gui-database/seed.sql    a folder that only shares its prefix
//     link-out      → ../outside            a link to a folder outside
//     link-in       → src                   a link to a folder inside
//     link-file.ts  → src/app.tsx           a link to a file inside
//     dangling      → ../outside/nowhere    a link to nothing
//     hard.ts                               a second name for outside/secret.txt
//     pipe                                  a named pipe
//   proj-other/a.ts            a sibling whose name starts with the project's
//   outside/secret.txt
//   via → proj                 the project, opened through a link
//   home/                      a made-up home folder (never the real one)

let base = ''
let proj = ''
let scope: EditScope

function write(file: string, text = 'x') {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

beforeAll(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-paths-'))
  proj = join(base, 'proj')
  write(join(proj, 'src/app.tsx'))
  mkdirSync(join(proj, 'src/components'))
  write(join(proj, 'package.json'), '{}')
  write(join(proj, 'gui-data/prefs.json'), '{}')
  write(join(proj, 'gui-database/seed.sql'))
  write(join(base, 'proj-other/a.ts'))
  write(join(base, 'outside/secret.txt'))
  symlinkSync('../outside', join(proj, 'link-out'))
  symlinkSync('src', join(proj, 'link-in'))
  symlinkSync('src/app.tsx', join(proj, 'link-file.ts'))
  symlinkSync('../outside/nowhere', join(proj, 'dangling'))
  linkSync(join(base, 'outside/secret.txt'), join(proj, 'hard.ts'))
  execFileSync('mkfifo', [join(proj, 'pipe')])
  symlinkSync('proj', join(base, 'via'))
  write(join(base, 'home/.zshrc'))
  write(join(base, 'home/.ssh/config'))
  write(join(base, 'home/Library/Preferences/app.plist'))
  write(join(base, 'home/Library/Application Support/Gui/prefs.json'))
  write(join(base, 'home/Library/Mobile Documents/site/index.html'))
  write(join(base, 'home/Documents/site/index.html'))
  scope = { root: proj, realRoot: proj, home: join(base, 'home'), protectedDirs: [] }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

/** Paths in the tables are written from the temp folder: `$` stands for it. */
const at = (path: string) => path.replace(/^\$/, base)

describe('isOutside: does a relative path climb out of its folder?', () => {
  // Its input is what `path.relative(folder, target)` returns, so it is already normalised.
  const cases: Array<[rel: string, outside: boolean, why: string]> = [
    ['', false, 'the folder itself'],
    ['src/app.tsx', false, 'a file inside'],
    ['.git/config', false, 'a dot-folder inside is still inside'],
    ['..', true, 'the parent'],
    ['../sibling', true, 'a sibling'],
    ['../../etc/passwd', true, 'further up'],
    ['/etc/passwd', true, 'not relative at all'],
    ['..foo', false, 'a name that only starts with two dots'],
    ['...', false, 'three dots is a name'],
    ['.../x', false, 'three dots is a folder name'],
    ['a/..b', false, 'two dots inside a later name'],
  ]
  test.each(cases)('%p → %p (%s)', (rel, outside) => {
    expect(isOutside(rel)).toBe(outside)
  })

  const pairs: Array<[folder: string, target: string, outside: boolean]> = [
    ['/proj', '/proj/src/app.tsx', false],
    ['/proj', '/proj', false],
    ['/proj/', '/proj', false],
    ['/proj', '/proj/', false],
    ['/proj', '/proj-other/a.ts', true],
    ['/proj', '/pro', true],
    ['/proj', '/', true],
    ['/proj/src', '/proj/package.json', true],
  ]
  test.each(pairs)('from %p, %p is outside: %p', (folder, target, outside) => {
    expect(isOutside(relative(folder, target))).toBe(outside)
  })
})

describe('projectEditPath: a change is approved only on a plain file inside the project', () => {
  const inside: Array<[path: string, lands: string, why: string]> = [
    ['src/app.tsx', 'src/app.tsx', 'a file, relative to the project'],
    ['$/proj/src/app.tsx', 'src/app.tsx', 'the same file, absolute'],
    ['./src/app.tsx', 'src/app.tsx', 'a leading ./'],
    ['src//app.tsx', 'src/app.tsx', 'a doubled slash'],
    ['src/app.tsx/', 'src/app.tsx', 'a trailing slash'],
    ['src/new.tsx', 'src/new.tsx', "a file that doesn't exist yet"],
    ['src/deep/er/new.tsx', 'src/deep/er/new.tsx', "in folders that don't exist yet"],
    ['..notes.md', '..notes.md', 'a name that only starts with two dots'],
    ['package.json', 'package.json', 'a sensitive file is still inside (auto-approve asks)'],
    ['SRC/app.tsx', 'SRC/app.tsx', 'other letter case: kept as the agent wrote it'],
  ]
  test.each(inside)('%p → %p (%s)', async (path, lands) => {
    expect(await projectEditPath(at(path), scope)).toBe(lands)
  })

  const asks: Array<[path: string, why: string]> = [
    ['../outside/secret.txt', 'climbs out with ..'],
    ['src/../../outside/secret.txt', 'climbs out from deeper'],
    ['src/../package.json', 'any .. asks, even one that stays inside'],
    ['src\\..\\..\\outside\\secret.txt', '.. between backslashes'],
    ['$/outside/secret.txt', 'absolute, outside'],
    ['$/proj-other/a.ts', "a sibling whose name starts with the project's"],
    ['$/proj/../proj-other/a.ts', 'the sibling, by way of the project'],
    ['$', 'the folder above the project'],
    ['/etc/hosts', 'a system file'],
    ['', 'empty: the project folder is not a file'],
    ['.', 'the project folder'],
    ['$/proj', 'the project folder, absolute'],
    ['$/proj/', 'the project folder with a trailing slash'],
    ['src', 'a folder'],
    ['src/components/', 'a folder with a trailing slash'],
    ['src/app.tsx/child.ts', 'a file used as a folder'],
    ['src/app.tsx\0.png', 'a NUL in the path'],
    ['link-out/secret.txt', 'through a link to a folder outside'],
    ['link-out/new.txt', 'a new file through that link'],
    ['link-in/app.tsx', 'through a link, even one that points inside'],
    ['link-file.ts', 'a link to a file'],
    ['dangling', 'a link to nothing'],
    ['dangling/new.txt', 'a new file under a link to nothing'],
    ['hard.ts', 'a hard link: also a file somewhere else'],
    ['pipe', 'a named pipe, not a file'],
  ]
  test.each(asks)('%p asks (%s)', async (path) => {
    expect(await projectEditPath(at(path), scope)).toBeNull()
  })

  // Claude Code expands a leading `~` to the home folder, and its adapter passes a path on
  // as the agent wrote it. Gui takes `~` for a folder in the project.
  //   input:    projectEditPath('~/notes.md', scope), the home folder not in the project
  //   expected: null (the user is asked: the file is outside the project)
  //   actual:   '~/notes.md' (approved as a file inside it)
  test.failing('a path from ~ is the home folder, which is outside the project', async () => {
    expect(await projectEditPath('~/notes.md', scope)).toBeNull()
  })
})

describe('projectEditPath with folders: what a read or a search may name', () => {
  const cases: Array<[path: string, lands: string | null, why: string]> = [
    ['', '', 'empty: the project folder'],
    ['.', '', 'the project folder'],
    ['$/proj', '', 'the project folder, absolute'],
    ['$/proj/', '', 'with a trailing slash'],
    ['src', 'src', 'a folder inside'],
    ['src/components/', 'src/components', 'a folder with a trailing slash'],
    ['src/app.tsx', 'src/app.tsx', 'a file inside'],
    ['src/missing', 'src/missing', "something that isn't there"],
    ['..', null, 'the parent'],
    ['$', null, 'the folder above, absolute'],
    ['$/proj-other', null, "a sibling whose name starts with the project's"],
    ['$/outside/secret.txt', null, 'a file outside'],
    ['link-in', null, 'a link to a folder inside'],
    ['link-out', null, 'a link to a folder outside'],
    ['link-out/secret.txt', null, 'a file through a link'],
    ['hard.ts', null, 'a hard link'],
    ['src/app.tsx/child.ts', null, 'a file used as a folder'],
  ]
  test.each(cases)('%p → %p (%s)', async (path, lands) => {
    expect(await projectEditPath(at(path), scope, true)).toBe(lands)
  })
})

describe('projectEditPath: a project opened through a link', () => {
  // The agent was given `via`; macOS reports files under the real `proj`. Both are the project.
  const cases: Array<[path: string, lands: string | null, why: string]> = [
    ['src/app.tsx', 'src/app.tsx', 'relative'],
    ['$/via/src/app.tsx', 'src/app.tsx', 'through the link, as the agent was given it'],
    ['$/proj/src/app.tsx', 'src/app.tsx', 'by its real path'],
    ['$/via/link-out/secret.txt', null, 'a link inside still asks'],
    ['$/proj-other/a.ts', null, 'a sibling of the real folder'],
    ['$/via-other/a.ts', null, 'a sibling of the link'],
  ]
  test.each(cases)('%p → %p (%s)', async (path, lands) => {
    const linked: EditScope = { ...scope, root: join(base, 'via') }
    expect(await projectEditPath(at(path), linked)).toBe(lands)
  })
})

describe("projectEditPath: Gui's own data always asks", () => {
  const guarded = (): EditScope => ({ ...scope, protectedDirs: [join(proj, 'gui-data')] })

  const cases: Array<[path: string, folders: boolean, lands: string | null, why: string]> = [
    ['gui-data/prefs.json', false, null, 'a file in it'],
    ['gui-data/new.json', false, null, 'a new file in it'],
    ['gui-data', true, null, 'reading the folder itself'],
    ['gui-data/prefs.json', true, null, 'reading a file in it'],
    ['gui-database/seed.sql', false, 'gui-database/seed.sql', 'a folder that shares its prefix'],
    ['src/app.tsx', false, 'src/app.tsx', 'the rest of the project'],
  ]
  test.each(cases)('%p (folders: %p) → %p (%s)', async (path, folders, lands) => {
    expect(await projectEditPath(path, guarded(), folders)).toBe(lands)
  })

  test('in another letter case, when the disk takes that for the same folder', async () => {
    // macOS disks usually ignore case, so GUI-DATA is gui-data; on a disk that doesn't,
    // it's a new folder of its own.
    const sameFolder = existsSync(join(proj, 'GUI-DATA'))
    expect(await projectEditPath('GUI-DATA/prefs.json', guarded())).toBe(
      sameFolder ? null : 'GUI-DATA/prefs.json',
    )
  })
})

describe('projectEditPath: when the project is the home folder, or holds it', () => {
  const cases: Array<[root: string, path: string, lands: string | null, why: string]> = [
    ['$/home', 'Documents/site/index.html', 'Documents/site/index.html', 'an ordinary file'],
    ['$/home', 'notes.md', 'notes.md', 'a new file in the home folder'],
    ['$/home', '.zshrc', null, 'a dotfile'],
    ['$/home', '.ssh/config', null, 'a file in a dot-folder'],
    ['$/home', '.config/new/settings.json', null, 'a new file in a new dot-folder'],
    ['$/home', 'Library/Preferences/app.plist', null, '~/Library'],
    ['$/home', 'Library/Application Support/Gui/prefs.json', null, "Gui's data in ~/Library"],
    ['$', 'home/.zshrc', null, 'a dotfile, from a project above the home folder'],
    ['$', 'home/Library/Preferences/app.plist', null, '~/Library, from above'],
    ['$', 'home/Documents/site/index.html', 'home/Documents/site/index.html', 'the rest'],
    // iCloud Drive and Dropbox keep projects under ~/Library: those are ordinary projects.
    ['$/home/Library/Mobile Documents/site', 'index.html', 'index.html', 'a project in ~/Library'],
  ]
  test.each(cases)('project %p, %p → %p (%s)', async (root, path, lands) => {
    const real = at(root)
    const homeScope: EditScope = { ...scope, root: real, realRoot: real }
    expect(await projectEditPath(path, homeScope)).toBe(lands)
  })

  test('reading is held to the same rule', async () => {
    const home = join(base, 'home')
    const homeScope: EditScope = { ...scope, root: home, realRoot: home }
    expect(await projectEditPath('.ssh', homeScope, true)).toBeNull()
    expect(await projectEditPath('Library', homeScope, true)).toBeNull()
    expect(await projectEditPath('Documents', homeScope, true)).toBe('Documents')
  })
})
