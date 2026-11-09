import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSkills, parseSkill, withSkills } from '../src/main/skills'

describe('parseSkill', () => {
  test('reads name and description from the frontmatter', () => {
    expect(
      parseSkill('---\nname: emil-animations\ndescription: Motion for product UI.\n---\n# Body'),
    ).toEqual({ frontmatter: true, name: 'emil-animations', description: 'Motion for product UI.' })
  })

  test('takes quoted and block values', () => {
    expect(parseSkill("---\nname: \"pdf\"\ndescription: 'Read PDFs, it''s quick'\n---")).toEqual({
      frontmatter: true,
      name: 'pdf',
      description: "Read PDFs, it's quick",
    })
    expect(
      parseSkill(
        '---\nname: forms\ndescription: >-\n  Forms and inputs.\n  Validation too.\nlicense: MIT\n---',
      ).description,
    ).toBe('Forms and inputs. Validation too.')
  })

  test('without frontmatter or fields, says so', () => {
    expect(parseSkill('# Just a heading\nname: x')).toEqual({
      frontmatter: false,
      name: null,
      description: '',
    })
    expect(parseSkill('---\ndescription: d\n---')).toEqual({
      frontmatter: true,
      name: null,
      description: 'd',
    })
  })
})

describe('findSkills', () => {
  let base: string
  let home: string
  let project: string

  const skill = (dir: string, folder: string, frontmatter: string | null = null) => {
    mkdirSync(join(dir, folder), { recursive: true })
    const text =
      frontmatter ?? `---\nname: ${folder}\ndescription: ${folder} skill\n---\n# ${folder}`
    writeFileSync(join(dir, folder, 'SKILL.md'), text)
  }
  const names = async (agent: string, env: NodeJS.ProcessEnv = {}) =>
    (await findSkills(agent, project, home, env)).map((s) => s.name)

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gui-skills-'))
    home = join(base, 'home')
    project = join(home, 'code', 'repo', 'apps', 'web')
    mkdirSync(project, { recursive: true })
  })

  afterEach(() => rmSync(base, { recursive: true, force: true }))

  test("OpenCode: the project's folders and every folder above, then the user's", async () => {
    skill(join(project, '.opencode', 'skills'), 'local')
    skill(join(project, '.opencode', 'skill'), 'singular')
    skill(join(home, 'code', 'repo', '.agents', 'skills'), 'repo-wide')
    skill(join(base, '.claude', 'skills'), 'outside-home')
    skill(join(home, '.config', 'opencode', 'skills'), 'mine')
    skill(join(home, '.claude', 'skills'), 'from-claude')
    skill(join(project, '.fx', 'skills'), 'fx-only')
    expect(await names('opencode')).toEqual([
      'local',
      'singular',
      'mine',
      'repo-wide',
      'from-claude',
      'outside-home',
    ])
  })

  test('OpenCode: the folder is the ID, nested folders count, and it’s named in words', async () => {
    skill(join(project, '.opencode', 'skills'), 'motion', '---\nname: Motion\ndescription: d\n---')
    skill(join(project, '.opencode', 'skills', 'design'), 'colors', '# no frontmatter')
    expect(await findSkills('opencode', project, home, {})).toEqual([
      { name: 'colors', description: '', hint: null, skill: true },
      { name: 'motion', description: 'd', hint: null, skill: true },
    ])
  })

  test('OpenCode: its own folders win over .agents, then .claude, and .claude can be off', async () => {
    skill(join(project, '.claude', 'skills'), 'review', '---\ndescription: claude\n---')
    skill(join(home, '.agents', 'skills'), 'review', '---\ndescription: agents\n---')
    expect((await findSkills('opencode', project, home, {}))[0]?.description).toBe('agents')
    skill(join(project, '.claude', 'skills'), 'claude-only')
    expect(await names('opencode', { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' })).toEqual([
      'review',
    ])
  })

  test('fx: its folders up to below home, written as $name', async () => {
    skill(join(project, 'skills'), 'bare')
    skill(join(home, 'code', '.codex', 'skills'), 'codex-one')
    skill(join(home, '.claw', 'skills'), 'claw-one')
    // The home folder itself is a user folder for fx, never a project one.
    skill(join(home, 'skills'), 'not-read')
    skill(join(project, '.opencode', 'skill'), 'singular-not-read')
    expect(await names('fx')).toEqual(['$bare', '$codex-one', '$claw-one'])
  })

  test("fx: the frontmatter's name, needed when there is frontmatter", async () => {
    skill(join(project, '.fx', 'skills'), 'folder', '---\nname: renamed\ndescription: d\n---')
    skill(join(project, '.fx', 'skills'), 'nameless', '---\ndescription: d\n---')
    skill(join(project, '.fx', 'skills'), 'plain', '# no frontmatter')
    skill(join(project, '.fx', 'skills'), 'spaced', '---\nname: Brand voice\n---')
    expect(await findSkills('fx', project, home, {})).toEqual([
      { name: '$renamed', description: 'd', hint: null },
      { name: '$plain', description: '', hint: null },
      { name: 'Brand voice', description: '', hint: null, skill: true },
    ])
  })

  test('follows a symlinked skill folder', async () => {
    skill(join(base, 'shared'), 'linked')
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
    symlinkSync(join(base, 'shared', 'linked'), join(home, '.agents', 'skills', 'linked'))
    expect(await names('opencode')).toEqual(['linked'])
  })

  test('agents that list their skills themselves get none from Gui', async () => {
    skill(join(home, '.claude', 'skills'), 'from-claude')
    expect(await names('claude')).toEqual([])
    expect(await names('codex')).toEqual([])
    expect(await names('pi')).toEqual([])
  })

  test("a skill named like one of the agent's commands is left out", () => {
    const own = [{ name: 'review', description: 'Review changes', hint: null }]
    const found = [
      { name: 'Review', description: 'A skill', hint: null, skill: true as const },
      { name: 'motion', description: 'Motion', hint: null, skill: true as const },
    ]
    expect(withSkills(own, found).map((c) => c.name)).toEqual(['review', 'motion'])
  })
})
