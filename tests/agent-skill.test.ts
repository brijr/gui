import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// `gui skill setup` / `gui skill remove` (bin/gui) write into the user's home folder. Each
// test runs the real script against an empty temp HOME.
const script = resolve(import.meta.dirname, '..', 'bin', 'gui')
const MARKER = '<!-- Installed by Gui.'

let home: string
let skillDir: string
let skillFile: string
let skillLink: string

const gui = (...args: string[]) =>
  execFileSync('/bin/sh', [script, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: home },
    encoding: 'utf8',
  })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gui-skill-'))
  skillDir = join(home, '.agents', 'skills', 'open-in-gui')
  skillFile = join(skillDir, 'SKILL.md')
  skillLink = join(home, '.claude', 'skills', 'open-in-gui')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('gui skill', () => {
  test('prints the skill with its name, trigger and marker', () => {
    const text = gui('skill')
    expect(text).toStartWith('---\nname: open-in-gui\n')
    expect(text).toContain('open it in Gui')
    expect(text).toContain(MARKER)
    expect(text).toContain('open -b dev.gui.app')
  })

  test('setup installs into an empty home, creating the parent folders', () => {
    const out = gui('skill', 'setup')
    expect(readFileSync(skillFile, 'utf8')).toBe(gui('skill'))
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(skillLink)).toBe('../../.agents/skills/open-in-gui')
    expect(realpathSync(join(skillLink, 'SKILL.md'))).toBe(realpathSync(skillFile))
    expect(out).toContain('Installed the open-in-gui skill')
    expect(out).toContain('gui skill remove')
  })

  test('setup is idempotent and updates a copy that carries the marker', () => {
    gui('skill', 'setup')
    writeFileSync(skillFile, `---\nname: open-in-gui\n---\n${MARKER} old -->\nold steps\n`)
    const out = gui('skill', 'setup')
    expect(readFileSync(skillFile, 'utf8')).toBe(gui('skill'))
    expect(out).toContain('Updated')
    expect(readlinkSync(skillLink)).toBe('../../.agents/skills/open-in-gui')
  })

  test("setup leaves the user's own skill folder alone and makes no link to it", () => {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, 'my own skill\n')
    const out = gui('skill', 'setup')
    expect(readFileSync(skillFile, 'utf8')).toBe('my own skill\n')
    expect(existsSync(skillLink)).toBe(false)
    expect(out).toContain('Left ~/.agents/skills/open-in-gui alone')
  })

  test('setup leaves an existing non-link ~/.claude/skills/open-in-gui alone', () => {
    mkdirSync(skillLink, { recursive: true })
    writeFileSync(join(skillLink, 'SKILL.md'), 'claude copy\n')
    const out = gui('skill', 'setup')
    expect(readFileSync(skillFile, 'utf8')).toBe(gui('skill'))
    expect(lstatSync(skillLink).isDirectory()).toBe(true)
    expect(readFileSync(join(skillLink, 'SKILL.md'), 'utf8')).toBe('claude copy\n')
    expect(out).toContain('Left ~/.claude/skills/open-in-gui alone')
  })

  test('remove takes out what setup installed', () => {
    gui('skill', 'setup')
    const out = gui('skill', 'remove')
    expect(existsSync(skillDir)).toBe(false)
    expect(lstatExists(skillLink)).toBe(false)
    expect(existsSync(join(home, '.agents', 'skills'))).toBe(true)
    expect(out).toContain('Removed ~/.agents/skills/open-in-gui.')
    expect(out).toContain('Removed ~/.claude/skills/open-in-gui.')
  })

  test('remove keeps files the user added to the skill folder', () => {
    gui('skill', 'setup')
    writeFileSync(join(skillDir, 'notes.md'), 'mine\n')
    gui('skill', 'remove')
    expect(existsSync(skillFile)).toBe(false)
    expect(readFileSync(join(skillDir, 'notes.md'), 'utf8')).toBe('mine\n')
  })

  test("remove leaves the user's own skill and its Claude link alone", () => {
    // The shape of a hand-made skill: the same folder and link, without Gui's marker.
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillFile, 'my own skill\n')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync('../../.agents/skills/open-in-gui', skillLink)
    const out = gui('skill', 'remove')
    expect(readFileSync(skillFile, 'utf8')).toBe('my own skill\n')
    expect(readlinkSync(skillLink)).toBe('../../.agents/skills/open-in-gui')
    expect(out).toContain('Left ~/.agents/skills/open-in-gui alone')
  })

  test('remove leaves a Claude link that points somewhere else', () => {
    gui('skill', 'setup')
    rmSync(skillLink)
    symlinkSync('/somewhere/else', skillLink)
    gui('skill', 'remove')
    expect(existsSync(skillDir)).toBe(false)
    expect(readlinkSync(skillLink)).toBe('/somewhere/else')
  })

  test('remove with nothing installed says so and changes nothing', () => {
    expect(gui('skill', 'remove')).toContain("isn't installed")
    expect(existsSync(join(home, '.agents'))).toBe(false)
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })
})

function lstatExists(path: string) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
