import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { type EditScope, projectEditPath } from '../src/main/chat-paths'
import type { AgentId } from '../src/shared/types'

// What Gui answers a permission request with on its own, and what it leaves to the user.
// docs/architecture.md ("Agents") is the specification:
//
//   Gui approves edits to ordinary source files in the project. In Auto mode it also approves
//   commands, fetches, and reads, picking only one-time approvals; it still asks when a
//   request names a file outside the project, edits a sensitive file (build, tool and deploy
//   config, dotfiles, dependency manifests and lockfiles, scripts, Dockerfiles, git hooks),
//   changes the agent's mode or plan, or the agent itself flags it.
//
// `decide` answers as chat.ts does (`ChatController.autoAnswer`): `autoApproval`, placing
// each path with `projectEditPath`. It returns the option picked, or null when the user is
// asked. Whether an answer is used is chat.ts's: an edit's always, anything else's in Auto.

let userData = ''
mock.module('electron', () => ({ app: { getPath: () => userData } }))
const {
  autoApproval,
  flaggedCaution,
  isAutoApprove,
  requestPaths,
  SENSITIVE_PATH,
  setAutoApprove,
} = await import('../src/main/auto-approve')

let base = ''
let scope: EditScope

beforeAll(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-auto-'))
  userData = join(base, 'gui-data')
  const proj = join(base, 'proj')
  const files = ['proj/src/app.tsx', 'proj/package.json', 'proj/.env', 'outside/secret.txt']
  for (const file of files) {
    mkdirSync(dirname(join(base, file)), { recursive: true })
    writeFileSync(join(base, file), 'x')
  }
  mkdirSync(join(base, 'proj-other'))
  symlinkSync('../outside', join(proj, 'link-out'))
  scope = { root: proj, realRoot: proj, home: join(base, 'home'), protectedDirs: [userData] }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const ONCE: PermissionOption = { optionId: 'once', name: 'Allow', kind: 'allow_once' }
const ALWAYS: PermissionOption = { optionId: 'always', name: 'Always allow', kind: 'allow_always' }
const NO: PermissionOption = { optionId: 'no', name: 'Reject', kind: 'reject_once' }
const NEVER: PermissionOption = { optionId: 'never', name: 'Never', kind: 'reject_always' }
/** What agents usually offer, in their order. */
const USUAL = [ONCE, ALWAYS, NO]

interface Asked {
  /** The tool kind; left out when neither the request nor its tool call says */
  kind?: string
  /** The request's `locations`; `$` stands for the temp folder */
  paths?: string[]
  /** The tool's raw input, where agents without `locations` put the path */
  input?: unknown
  options?: PermissionOption[]
  agentId?: AgentId
}

function request({ kind, paths, input, options = USUAL }: Asked): RequestPermissionRequest {
  return {
    sessionId: 'session',
    options,
    toolCall: {
      toolCallId: 'tool',
      kind: kind as RequestPermissionRequest['toolCall']['kind'],
      locations: paths?.map((path) => ({ path: path.replace(/^\$/, base) })),
      rawInput: input,
    },
  }
}

function decide(asked: Asked) {
  return autoApproval(request(asked), {
    agentId: asked.agentId ?? 'codex',
    kind: asked.kind ?? null,
    place: (path, write) => projectEditPath(path, scope, !write),
  })
}

const edit = (...paths: string[]): Asked => ({ kind: 'edit', paths })

describe('answered without asking, with a one-time approval', () => {
  const cases: Array<[what: string, asked: Asked]> = [
    ['an edit to a source file', edit('src/app.tsx')],
    ['an edit named by its absolute path', edit('$/proj/src/app.tsx')],
    ['a new file', edit('src/components/button.tsx')],
    ['an edit to several source files', edit('src/app.tsx', 'src/main.tsx')],
    ['deleting a source file', { kind: 'delete', paths: ['src/app.tsx'] }],
    ['moving a file within the project', { kind: 'move', paths: ['src/app.tsx', 'src/home.tsx'] }],
    ['an edit that names its file in the raw input', { kind: 'edit', input: { path: 'src/a.ts' } }],
    ['a command', { kind: 'execute' }],
    ['a command in the project folder', { kind: 'execute', paths: ['$/proj'] }],
    ['a fetch', { kind: 'fetch' }],
    ['a read', { kind: 'read', paths: ['src/app.tsx'] }],
    ['a read of package.json: only changes to it ask', { kind: 'read', paths: ['package.json'] }],
    ['a search of a folder', { kind: 'search', paths: ['src'] }],
    ['a search of the whole project', { kind: 'search', paths: ['$/proj'] }],
    ['a tool of no particular kind', { kind: 'other' }],
    ['a tool that says no kind at all', {}],
  ]
  test.each(cases)('%s', async (_what, asked) => {
    expect(await decide(asked)).toBe('once')
  })
})

describe('only one-time approvals are picked', () => {
  const cases: Array<[what: string, options: PermissionOption[], answer: string | null]> = [
    ['"allow once" among the usual options', [ONCE, ALWAYS, NO], 'once'],
    ['"allow once" when "always" comes first', [ALWAYS, ONCE, NO], 'once'],
    ['only "always allow" on offer: asks', [ALWAYS, NO], null],
    ['only ways to say no: asks', [NO, NEVER], null],
    ['nothing on offer: asks', [], null],
  ]
  test.each(cases)('%s', async (_what, options, answer) => {
    expect(await decide({ kind: 'execute', options })).toBe(answer)
    expect(await decide({ ...edit('src/app.tsx'), options })).toBe(answer)
  })
})

describe('asks: the request names a file outside the project', () => {
  const cases: Array<[what: string, asked: Asked]> = [
    ['a read of a system file', { kind: 'read', paths: ['/etc/hosts'] }],
    ['a read that climbs out with ..', { kind: 'read', paths: ['../outside/secret.txt'] }],
    ['a read through a link to outside', { kind: 'read', paths: ['link-out/secret.txt'] }],
    ['a search of the folder above', { kind: 'search', paths: ['$'] }],
    ['a command in another folder', { kind: 'execute', paths: ['$/outside'] }],
    ['an edit outside', edit('$/outside/secret.txt')],
    ["an edit in a sibling whose name starts with the project's", edit('$/proj-other/a.ts')],
    ['an edit through a link', edit('link-out/secret.txt')],
    ['an edit to several files, one of them outside', edit('src/app.tsx', '$/outside/a.ts')],
    ['a move out of the project', { kind: 'move', paths: ['src/app.tsx', '$/outside/app.tsx'] }],
    ["a change to Gui's own data", edit('$/gui-data/prefs.json')],
    ['a tool of no kind that names a file outside', { paths: ['/etc/hosts'] }],
    ['an edit whose raw input names a file outside', { kind: 'edit', input: { path: '/etc/x' } }],
  ]
  test.each(cases)('%s', async (_what, asked) => {
    expect(await decide(asked)).toBeNull()
  })

  // See tests/chat-paths.test.ts: to Claude Code, `~/notes.md` is a file in the home folder.
  //   input:    an edit to `~/notes.md`, the usual options on offer
  //   expected: null (asks: the file is outside the project)
  //   actual:   'once' (approved)
  test.failing('an edit to a path from ~, the home folder', async () => {
    expect(await decide(edit('~/notes.md'))).toBeNull()
  })
})

describe('asks: the change is to a sensitive file', () => {
  // By family (`SENSITIVE_NAMES` in auto-approve.ts): the next tool's file should ask too.
  const sensitive: Array<[group: string, paths: string[]]> = [
    [
      'config',
      [
        'vite.config.ts',
        'next.config.mjs',
        'tailwind.config.cjs',
        'apps/web/eslint.config.js',
        'babel.config.json',
        'jest.config.json',
        'postcss.config.yaml',
        'web.config',
        'tsconfig.json',
        'tsconfig.node.json',
        'jsconfig.json',
        'biome.json',
        'bunfig.toml',
        'supabase/config.toml',
        'tox.ini',
        'setup.cfg',
        'nginx.conf',
      ],
    ],
    [
      'containers',
      [
        'Dockerfile',
        'Dockerfile.dev',
        'apps/api/Dockerfile.prod',
        'web.Dockerfile',
        'Containerfile',
        'docker-compose.yml',
        'docker-compose.override.yml',
        'compose.yaml',
        'compose.dev.yml',
      ],
    ],
    [
      'dotfiles',
      ['.env', '.gitignore', '.eslintrc.json', '.github/workflows/ci.yml', 'src/.cache/a.ts'],
    ],
    [
      'lockfiles',
      [
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
        'deno.lock',
        'Cargo.lock',
        'uv.lock',
        'Gemfile.lock',
        'go.sum',
        'packages.lock.json',
      ],
    ],
    ['scripts', ['scripts/release.ts', 'bin/cli.js', 'deploy.sh', 'tools/setup.bash', 'env.zsh']],
    ['package.json', ['package.json', 'apps/web/package.json', 'PACKAGE.JSON']],
    [
      'manifests and workspaces',
      [
        'pnpm-workspace.yaml',
        'deno.json',
        'deno.jsonc',
        'requirements.txt',
        'requirements-dev.txt',
        'pyproject.toml',
        'setup.py',
        'Pipfile',
        'Cargo.toml',
        'go.mod',
        'go.work',
        'Gemfile',
        'app.gemspec',
        'composer.json',
        'pom.xml',
        'build.gradle',
        'Package.swift',
        'pubspec.yaml',
        'flake.nix',
      ],
    ],
    [
      'deploy and CI',
      [
        'vercel.json',
        'apps/web/vercel.json',
        'netlify.toml',
        'wrangler.toml',
        'wrangler.jsonc',
        'fly.toml',
        'render.yaml',
        'firebase.json',
        'serverless.yml',
        'Procfile',
        'azure-pipelines.yml',
        'Jenkinsfile',
      ],
    ],
    [
      'task runners',
      [
        'Makefile',
        'rules.mk',
        'justfile',
        'Taskfile.yml',
        'Rakefile',
        'gulpfile.js',
        'turbo.json',
        'nx.json',
        'nodemon.json',
      ],
    ],
    [
      'git hooks',
      [
        '.git/hooks/pre-commit',
        '.githooks/pre-commit',
        '.husky/pre-push',
        '.pre-commit-config.yaml',
        'lefthook.yml',
        'lefthook-local.yml',
        'simple-git-hooks.json',
        'lint-staged.config.js',
      ],
    ],
    ['dependencies', ['node_modules/react/index.js', 'apps/web/node_modules/zod/index.js']],
  ]
  for (const [group, paths] of sensitive) {
    test.each(paths)(`${group}: an edit to %s`, async (path) => {
      expect(await decide(edit(path))).toBeNull()
      // The permission card marks the same files (`sensitive`).
      expect(SENSITIVE_PATH.test(path)).toBe(true)
    })
  }

  const changes: Array<[what: string, asked: Asked]> = [
    ['deleting one', { kind: 'delete', paths: ['package.json'] }],
    ['moving a file onto one', { kind: 'move', paths: ['src/app.tsx', 'scripts/app.tsx'] }],
    ['one among ordinary files', edit('src/app.tsx', 'vite.config.ts')],
    ['one named only in the raw input', { kind: 'edit', input: { file_path: 'package.json' } }],
  ]
  test.each(changes)('%s', async (_what, asked) => {
    expect(await decide(asked)).toBeNull()
  })

  // Ordinary content stays automatic, or every edit would ask. JSON and YAML are sensitive
  // by name, never by extension, and a source file named after a tool is a source file.
  const ordinary = [
    'src/app.tsx',
    'src/components/Button.tsx',
    'src/styles/app.css',
    'README.md',
    'content/about.md',
    'public/logo.svg',
    'public/robots.txt',
    // Data and copy in the formats config is also written in.
    'src/data/products.json',
    'src/data/config.json',
    'locales/en.json',
    'locales/en/compose.json',
    'public/manifest.json',
    'content/post.yaml',
    'src/i18n/messages.yml',
    'openapi.yaml',
    // Names that only look like a sensitive one.
    'src/config.ts',
    'src/app-config.ts',
    'src/config/site.ts',
    'src/lib/scripts.ts',
    'src/bin.ts',
    'src/package.json.ts',
    'src/lockfile.ts',
    'src/lock.ts',
    'src/requirements.ts',
    'src/setup.ts',
    'src/pages/profile.tsx',
    'src/models/workspace.ts',
    'src/hooks/use-workspace.ts',
    'src/components/compose.tsx',
    'src/lib/docker.ts',
    'src/dockerfile-parser.ts',
    'src/lib/firebase.ts',
    'src/lib/vercel.ts',
    'src/utils/render.ts',
    'src/data/render.json',
    'src/turbo.ts',
    // Pages about a sensitive file.
    'docs/install.sh.md',
    'docs/vite.config.md',
    'docs/docker-compose.md',
    'docs/requirements.md',
  ]
  test.each(ordinary)('an ordinary file is not one: %s', async (path) => {
    expect(SENSITIVE_PATH.test(path)).toBe(false)
    expect(await decide(edit(path))).toBe('once')
  })
})

describe('asks: a change that names no file', () => {
  const cases: Array<[what: string, asked: Asked]> = [
    ['an edit with no locations and no input', { kind: 'edit' }],
    ['a delete with no locations', { kind: 'delete', paths: [] }],
    ['an edit whose input has no path', { kind: 'edit', input: { command: 'sed -i' } }],
    ['an edit that names the project folder', edit('$/proj')],
  ]
  test.each(cases)('%s', async (_what, asked) => {
    expect(await decide(asked)).toBeNull()
  })
})

describe("asks: a change of the agent's mode or plan", () => {
  // Claude's plan approval arrives as a mode switch.
  const agents: AgentId[] = ['claude', 'codex', 'muse', 'cursor']
  test.each(agents)('a mode switch from %s', async (agentId) => {
    expect(await decide({ kind: 'switch_mode', agentId })).toBeNull()
  })
})

describe('asks: the agent itself flags the request', () => {
  const question = [
    { optionId: 'skip', name: 'Skip', kind: 'reject_once' },
    { optionId: '0', name: 'Blue', kind: 'answer' },
  ] as PermissionOption[]

  const cases: Array<[what: string, asked: Asked, flagged: boolean]> = [
    ['"no" is its first option', { kind: 'execute', options: [NO, ONCE, ALWAYS] }, true],
    ['"never" is its first option', { kind: 'execute', options: [NEVER, ONCE] }, true],
    [
      "Gui's own question cards, which put Skip first",
      { kind: 'question', options: question },
      true,
    ],
    [
      'Claude offers no "always allow" (its ask rules and safety checks)',
      { kind: 'execute', agentId: 'claude', options: [ONCE, NO] },
      true,
    ],
    ['Claude with its usual options', { kind: 'execute', agentId: 'claude' }, false],
    [
      'another agent that never offers "always allow"',
      { kind: 'execute', agentId: 'codex', options: [ONCE, NO] },
      false,
    ],
    ['a mode switch', { kind: 'switch_mode' }, true],
    ['a command with the usual options', { kind: 'execute' }, false],
  ]
  test.each(cases)('%s', async (_what, asked, flagged) => {
    const agentId = asked.agentId ?? 'codex'
    expect(flaggedCaution(request(asked), agentId, asked.kind ?? null)).toBe(flagged)
    const answer = await decide(asked)
    if (flagged) expect(answer).toBeNull()
    else expect(answer).toBe('once')
  })

  test('a flagged edit to an ordinary source file asks too', async () => {
    expect(await decide({ ...edit('src/app.tsx'), options: [NO, ONCE] })).toBeNull()
    expect(
      await decide({ ...edit('src/app.tsx'), agentId: 'claude', options: [ONCE, NO] }),
    ).toBeNull()
  })
})

describe('requestPaths: the files a request names', () => {
  const cases: Array<[what: string, asked: Asked, paths: string[]]> = [
    ['its locations', { paths: ['src/a.ts', 'src/b.ts'] }, ['src/a.ts', 'src/b.ts']],
    [
      'its locations, not its input, when it has both',
      { paths: ['a.ts'], input: { path: 'b.ts' } },
      ['a.ts'],
    ],
    ['`path` in the input', { input: { path: 'a.ts' } }, ['a.ts']],
    ['`file_path` in the input', { input: { file_path: 'a.ts' } }, ['a.ts']],
    ['`filePath` in the input', { input: { filePath: 'a.ts' } }, ['a.ts']],
    ['`notebook_path` in the input', { input: { notebook_path: 'a.ipynb' } }, ['a.ipynb']],
    [
      'every path field the input has',
      { input: { path: 'a.ts', file_path: 'b.ts' } },
      ['a.ts', 'b.ts'],
    ],
    ['the input when locations are empty', { paths: [], input: { path: 'a.ts' } }, ['a.ts']],
    ['nothing from a field that is empty or not text', { input: { path: '', file_path: 7 } }, []],
    ['nothing from other fields', { input: { command: 'cat a.ts', cwd: '/tmp' } }, []],
    ['nothing from a list', { input: ['a.ts'] }, []],
    ['nothing from text', { input: 'a.ts' }, []],
    ['nothing from no input', {}, []],
  ]
  test.each(cases)('%s', (_what, asked, paths) => {
    expect(requestPaths(request(asked))).toEqual(paths)
  })
})

describe('Auto is on for a project unless the user switched it off there', () => {
  test('every project starts in Auto, and switching one to Ask leaves the others', () => {
    const one = join(base, 'proj')
    const other = join(base, 'proj-other')
    expect(isAutoApprove(one)).toBe(true)
    expect(isAutoApprove(other)).toBe(true)

    setAutoApprove(one, false)
    expect(isAutoApprove(one)).toBe(false)
    expect(isAutoApprove(other)).toBe(true)
    expect(isAutoApprove(join(one, 'apps/web'))).toBe(true)

    // Asking twice is the same as once, and Auto again forgets the project.
    setAutoApprove(one, false)
    setAutoApprove(other, false)
    setAutoApprove(one, true)
    setAutoApprove(one, true)
    expect(isAutoApprove(one)).toBe(true)
    expect(isAutoApprove(other)).toBe(false)
    setAutoApprove(other, true)
    expect(isAutoApprove(other)).toBe(true)
  })
})
