import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceControlAction } from '../src/shared/source-control'
import { electronExecutable, waitFor } from './helpers/env'
import { git } from './helpers/fixtures'
import { chooseFromBranchMenu } from './helpers/menus'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

function identity(root: string) {
  git(root, 'branch', '-M', 'main')
  git(root, 'config', 'user.name', 'Gui E2E')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', '/dev/null')
}
function remote(session: GuiSession) {
  const { root, base } = session.fixture
  const origin = join(base, 'origin.git')
  git(base, 'init', '--quiet', '--bare', origin)
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '--quiet', '-u', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', 'main')
  return origin
}
async function status(session: GuiSession) {
  return waitFor(
    () => session.chat.evaluate(async () => (await window.gui.getShipInfo())?.workspace),
    'repository workspace',
  )
}
async function settledShot(session: GuiSession, path: string) {
  await session.chat.evaluate(async () => {
    const transitions = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === 'running' &&
          animation.effect?.getComputedTiming().activeDuration !== Infinity,
      )
    await Promise.race([
      Promise.allSettled(transitions.map((animation) => animation.finished)),
      new Promise((resolve) => setTimeout(resolve, 750)),
    ])
  })
  await expect
    .poll(() =>
      session.chat.evaluate(() =>
        [...document.querySelectorAll('dialog[open]')].every(
          (dialog) => getComputedStyle(dialog).opacity === '1',
        ),
      ),
    )
    .toBe(true)
  await session.chat.screenshot({ path })
}
async function act(session: GuiSession, action: SourceControlAction) {
  const expected = await status(session)
  return session.chat.evaluate((request) => window.gui.sourceControl(request), {
    ...action,
    expected,
  })
}
async function answerPush(session: GuiSession, answer: number) {
  await session.app.evaluate(({ dialog }, answer) => {
    const store = globalThis as unknown as {
      pushPrompts: { message: string; buttons: string[]; defaultId: number; cancelId: number }[]
    }
    store.pushPrompts = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as (typeof store.pushPrompts)[number]
      store.pushPrompts.push(options)
      return { response: answer, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, answer)
}

test('clean branch management and repeated commits preserve file choices across refresh', async ({
  launch,
}, testInfo) => {
  const session = await launch({
    fixture: 'vite',
    prefs: { chatSize: { width: 360, height: 650 } },
  })
  const { root } = session.fixture
  identity(root)
  remote(session)
  await status(session)
  // The toolbar's branch menu is the one way in; Back to chat closes it.
  const openSheet = () => chooseFromBranchMenu(session.app, session.chrome, 'Source Control…')
  await openSheet()
  await expect(session.chat.getByText(/No uncommitted changes/)).toBeVisible()
  await session.chat.getByRole('button', { name: 'Back to chat' }).first().dispatchEvent('click')
  await expect(session.chat.getByText(/No uncommitted changes/)).not.toBeVisible()
  await openSheet()
  await expect(session.chat.getByText(/No uncommitted changes/)).toBeVisible()
  await session.chat.getByRole('button', { name: 'New branch', exact: true }).dispatchEvent('click')
  await expect(session.chat.getByRole('textbox', { name: 'Branch name' })).toBeFocused()
  await session.chat.getByRole('textbox', { name: 'Branch name' }).fill('feature/source-control')
  await settledShot(session, testInfo.outputPath('source-control-create-branch.png'))
  await session.chat.getByRole('button', { name: 'Create and switch' }).dispatchEvent('click')
  await expect(
    session.chat.getByRole('button', { name: /Select branch, current branch feature/ }),
  ).toBeVisible()
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feature/source-control')
  await expect(
    session.chat.getByRole('button', { name: /Select branch, current branch/ }),
  ).toBeEnabled()
  await session.chat
    .getByRole('button', { name: /Select branch, current branch/ })
    .dispatchEvent('click')
  await expect(session.chat.getByRole('textbox', { name: 'Find a branch' })).toBeVisible()
  await settledShot(session, testInfo.outputPath('source-control-branch-picker.png'))
  await session.chat
    .getByRole('dialog', { name: 'Switch branch' })
    .getByRole('button', { name: 'Close', exact: true })
    .dispatchEvent('click')
  appendFileSync(join(root, 'src/App.tsx'), '\n// First commit\n')
  appendFileSync(join(root, 'src/index.css'), '\n/* Second commit */\n')
  await session.chat.getByRole('button', { name: 'Refresh source control' }).dispatchEvent('click')
  // Files that appear while the panel is open never silently become selected.
  await expect(
    session.chat.getByRole('checkbox', { name: 'Include src/App.tsx' }),
  ).not.toBeChecked()
  await session.chat.getByRole('checkbox', { name: 'Include src/App.tsx' }).dispatchEvent('click')
  await session.chat.getByRole('textbox', { name: 'Commit message' }).fill('First selected group')
  writeFileSync(join(root, 'new.txt'), 'Keep this unselected\n')
  await session.chat.getByRole('button', { name: 'Refresh source control' }).dispatchEvent('click')
  await expect(session.chat.getByRole('checkbox', { name: 'Include new.txt' })).not.toBeChecked()
  await expect(session.chat.getByRole('checkbox', { name: 'Include src/App.tsx' })).toBeChecked()
  await expect(session.chat.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'First selected group',
  )
  await session.chat
    .getByRole('button', { name: 'Commit 1 file', exact: true })
    .dispatchEvent('click')
  await expect(session.chat.getByText(/^Commit saved/)).toBeVisible()
  expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(
    'src/App.tsx',
  )
  await expect(session.chat.getByRole('textbox', { name: 'Commit message' })).toHaveValue('')
  await session.chat.getByRole('checkbox', { name: 'Include src/index.css' }).dispatchEvent('click')
  await session.chat.getByRole('textbox', { name: 'Commit message' }).fill('Second selected group')
  await expect(session.chat.getByRole('button', { name: 'Push', exact: true })).toBeEnabled()
  await settledShot(session, testInfo.outputPath('source-control-light.png'))
  await session.chat
    .getByRole('banner')
    .first()
    .screenshot({ path: testInfo.outputPath('source-control-header.png') })
  await session.chat
    .getByRole('button', { name: 'Commit 1 file', exact: true })
    .dispatchEvent('click')
  await expect(session.chat.getByRole('textbox', { name: 'Commit message' })).toHaveValue('')
  expect(git(root, 'log', '-2', '--format=%s').trim().split('\n')).toEqual([
    'Second selected group',
    'First selected group',
  ])
  expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(
    'src/index.css',
  )
  await expect(session.chat.getByRole('button', { name: 'New branch', exact: true })).toBeEnabled()
  await session.chat.emulateMedia({ colorScheme: 'dark' })
  await settledShot(session, testInfo.outputPath('source-control-dark.png'))
  expect(
    await session.chat.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true)
})

test('branch switching handles remote-only refs, occupied worktrees, dirty files and detached HEAD', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { root, base } = session.fixture
  identity(root)
  remote(session)
  git(root, 'branch', 'remote-feature')
  git(root, 'push', '--quiet', 'origin', 'remote-feature')
  git(root, 'branch', '-D', 'remote-feature')
  await act(session, { kind: 'switch', branch: 'remote-feature', remote: 'origin' })
  expect(git(root, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/remote-feature')
  await act(session, { kind: 'switch', branch: 'main', remote: null })
  git(root, 'branch', 'occupied')
  git(root, 'worktree', 'add', '--quiet', join(base, 'other-tree'), 'occupied')
  expect(
    (await status(session)).branches.find((branch) => branch.name === 'occupied')
      ?.checkedOutElsewhere,
  ).toBe(true)
  await expect(act(session, { kind: 'switch', branch: 'occupied', remote: null })).rejects.toThrow(
    /worktree/,
  )
  git(root, 'switch', '--quiet', '-c', 'different')
  appendFileSync(join(root, 'src/App.tsx'), '\n// Different branch\n')
  git(root, 'commit', '--quiet', '-am', 'Different branch contents')
  git(root, 'switch', '--quiet', 'main')
  appendFileSync(join(root, 'src/App.tsx'), '\n// Keep my edit\n')
  await expect(act(session, { kind: 'switch', branch: 'different', remote: null })).rejects.toThrow(
    /overwriting/,
  )
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main')
  expect(readFileSync(join(root, 'src/App.tsx'), 'utf8')).toContain('Keep my edit')
  git(root, 'switch', '--quiet', '--detach', 'HEAD')
  await expect(
    act(session, { kind: 'commit', files: ['src/App.tsx'], title: 'Detached', body: '' }),
  ).rejects.toThrow(/detached/)
  await act(session, { kind: 'create', branch: 'feature/from-detached', base: null })
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('feature/from-detached')
})

test('main, master, custom defaults and upstream destinations all require main-owned confirmation', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { root } = session.fixture
  identity(root)
  const origin = remote(session)
  for (const branch of ['main', 'master', 'trunk']) {
    if (branch !== 'main') {
      git(root, 'switch', '--quiet', '-c', branch)
      git(root, 'push', '--quiet', '-u', 'origin', branch)
      git(root, 'remote', 'set-head', 'origin', branch)
    }
    git(root, 'commit', '--quiet', '--allow-empty', '-m', `Outgoing ${branch}`)
    const saved = git(root, 'rev-parse', 'HEAD').trim()
    const before = git(origin, 'rev-parse', branch).trim()
    for (const [answer, outcome] of [
      [0, 'cancelled'],
      [1, 'branch-required'],
    ] as const) {
      await answerPush(session, answer)
      expect((await act(session, { kind: 'push' })).outcome).toBe(outcome)
      expect(git(origin, 'rev-parse', branch).trim()).toBe(before)
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(saved)
      const prompt = await session.app.evaluate(
        () =>
          (
            globalThis as unknown as {
              pushPrompts: { message: string; defaultId: number; cancelId: number }[]
            }
          ).pushPrompts[0],
      )
      expect(prompt?.message).toContain(`origin/${branch}`)
      expect(prompt?.defaultId).toBe(0)
      expect(prompt?.cancelId).toBe(0)
    }
    await answerPush(session, 2)
    expect((await act(session, { kind: 'push' })).outcome).toBe('pushed')
    expect(git(origin, 'rev-parse', branch).trim()).toBe(saved)
  }
  git(root, 'switch', '--quiet', '-c', 'feature/upstream-main')
  git(root, 'config', 'branch.feature/upstream-main.remote', 'origin')
  git(root, 'config', 'branch.feature/upstream-main.merge', 'refs/heads/main')
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'Do not publish without review')
  await answerPush(session, 0)
  expect((await act(session, { kind: 'push' })).outcome).toBe('cancelled')
  const prompt = await session.app.evaluate(
    () => (globalThis as unknown as { pushPrompts: { message: string }[] }).pushPrompts[0],
  )
  expect(prompt?.message).toContain('origin/main')
  // Legacy Share uses the same confirmation gate, even with an empty file selection.
  git(root, 'switch', '--quiet', 'main')
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'Legacy pending commit')
  await expect(
    session.chat.evaluate(() =>
      window.gui.ship({ mode: 'share', files: [], branch: 'main', title: 'Legacy push', body: '' }),
    ),
  ).rejects.toThrow(/cancelled/)
  const localMain = git(root, 'rev-parse', 'main').trim()
  await answerPush(session, 1)
  await chooseFromBranchMenu(session.app, session.chrome, 'Source Control…')
  await expect(session.chat.getByRole('button', { name: 'Push', exact: true })).toBeEnabled()
  await session.chat.getByRole('button', { name: 'Push', exact: true }).dispatchEvent('click')
  await expect(session.chat.getByRole('dialog', { name: 'Create a branch' })).toBeVisible()
  await expect(session.chat.getByRole('textbox', { name: 'Branch name' })).toBeFocused()
  await session.chat.getByRole('textbox', { name: 'Branch name' }).fill('feature/main-commits')
  await session.chat.getByRole('button', { name: 'Create and switch' }).dispatchEvent('click')
  await expect(
    session.chat.getByRole('button', {
      name: /Select branch, current branch feature\/main-commits/,
    }),
  ).toBeVisible()
  expect(git(root, 'rev-parse', 'main').trim()).toBe(localMain)
  expect(git(root, 'rev-parse', 'feature/main-commits').trim()).toBe(localMain)
})

test('a changed repository invalidates push approval and concurrent Git actions cannot interleave', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { root } = session.fixture
  identity(root)
  const origin = remote(session)
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'Pending')
  const before = git(origin, 'rev-parse', 'main').trim()
  await session.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (() =>
      new Promise((resolve) => {
        Object.assign(globalThis, {
          releasePush: () => resolve({ response: 2, checkboxChecked: false }),
        })
      })) as typeof dialog.showMessageBox
  })
  const expected = await status(session)
  const pushing = session.chat.evaluate(
    (expected) =>
      window.gui.sourceControl({ kind: 'push', expected }).then(
        () => '',
        (error: Error) => error.message,
      ),
    expected,
  )
  await waitFor(
    () =>
      session.app.evaluate(
        () =>
          typeof (globalThis as unknown as { releasePush?: unknown }).releasePush === 'function',
      ),
    'push warning',
  )
  await expect(
    act(session, { kind: 'create', branch: 'feature/concurrent', base: 'refs/heads/main' }),
  ).rejects.toThrow(/Another Git action/)
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'External change while confirming')
  await session.app.evaluate(() =>
    (globalThis as unknown as { releasePush: () => void }).releasePush(),
  )
  expect(await pushing).toContain('changed while preparing')
  expect(git(origin, 'rev-parse', 'main').trim()).toBe(before)
})

test('an unsafe unselected file does not hide the workspace or block a safe selected commit', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { root } = session.fixture
  identity(root)
  appendFileSync(join(root, 'src/App.tsx'), '\n// Safe selection\n')
  writeFileSync(join(root, 'unsafe.txt'), `token=${'ghp_'}${'Q'.repeat(36)}\n`)
  await status(session)
  expect((await session.chat.evaluate(() => window.gui.getShipInfo()))?.blocked).toBeNull()
  await act(session, { kind: 'commit', title: 'Safe only', body: '', files: ['src/App.tsx'] })
  expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(
    'src/App.tsx',
  )
  await expect(
    act(session, { kind: 'commit', title: 'Unsafe selection', body: '', files: ['unsafe.txt'] }),
  ).rejects.toThrow(/secret|token|credential/i)
})

const RUNNING_AGENT = String.raw`
const { existsSync } = require('node:fs')
const write = message => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', ...message })+'\n')
let buffer='',mcp
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer+=chunk
  for(let end=buffer.indexOf('\n');end!==-1;end=buffer.indexOf('\n')) {
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
    if(!line.trim())continue
    const {id,method,params}=JSON.parse(line)
    if(method==='initialize')write({id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true}},authMethods:[]}})
    else if(method==='session/new'){mcp=params.mcpServers.find(server=>server.url);write({id,result:{sessionId:'running-agent'}})}
    else if(method==='session/prompt') {
      const timer=setInterval(async()=>{if(existsSync(process.argv[2])){
        clearInterval(timer)
        const headers={'content-type':'application/json',accept:'application/json, text/event-stream'}
        for(const header of mcp.headers)headers[header.name]=header.value
        await fetch(mcp.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'source_control_propose',arguments:{mode:'commit',title:'Agent proposed after the turn',body:'',files:['src/App.tsx']}}})})
        write({id,result:{stopReason:'end_turn'}})
      }},100)
    }
  }
})
`
test('draft typing and file selection remain available while the agent runs', async ({
  launch,
}, testInfo) => {
  const session = await launch({
    fixture: 'vite',
    prefs: { chatSidebar: true, chatSidebarWidth: 320 },
  })
  const { root, base } = session.fixture
  identity(root)
  const script = join(base, 'running-agent.cjs')
  const release = join(base, 'release-agent')
  writeFileSync(script, RUNNING_AGENT)
  writeFileSync(
    standInsFile(session.fixture),
    JSON.stringify({
      grok: {
        command: electronExecutable(),
        args: [script, release],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    }),
  )
  await session.chrome.evaluate(() => window.gui.setAgent('grok'))
  await waitFor(
    async () => (await session.chatSnapshot()).meta.agentId === 'grok',
    'stand-in agent',
  )
  appendFileSync(join(root, 'src/App.tsx'), '\n// Keep this draft selection\n')
  await status(session)
  expect(await session.chat.evaluate(() => window.gui.send('Hold this turn', []))).toBe(true)
  await waitFor(
    async () => (await session.chatSnapshot()).turns.some((turn) => turn.status === 'running'),
    'running turn',
  )
  await chooseFromBranchMenu(session.app, session.chrome, 'Source Control…')
  await session.chat
    .getByRole('textbox', { name: 'Commit message' })
    .fill('Draft written during the turn')
  await expect(session.chat.getByRole('checkbox', { name: 'Include src/App.tsx' })).toBeEnabled()
  await expect(
    session.chat.getByRole('button', { name: 'Commit 1 file', exact: true }),
  ).toBeDisabled()
  await expect(session.chat.getByRole('button', { name: 'New branch', exact: true })).toBeDisabled()
  await expect(
    act(session, { kind: 'commit', title: 'Bypass UI', body: '', files: ['src/App.tsx'] }),
  ).rejects.toThrow(/agent/)
  await settledShot(session, testInfo.outputPath('source-control-running-narrow.png'))
  await session.chat
    .getByRole('banner')
    .first()
    .screenshot({ path: testInfo.outputPath('source-control-header-narrow.png') })
  writeFileSync(release, 'done')
  await session.waitForTurn(0)
  await expect(session.chat.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Draft written during the turn',
  )
  await expect(
    session.chat.getByRole('button', { name: 'Commit 1 file', exact: true }),
  ).toBeEnabled()
  await expect(session.chat.getByRole('button', { name: 'Use agent proposal' })).toBeVisible()
  await session.chat.getByRole('button', { name: 'Use agent proposal' }).dispatchEvent('click')
  await expect(session.chat.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Agent proposed after the turn',
  )
})

test('a first commit supports creating an unborn branch and commits additions, deletions and renames exactly', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { root } = session.fixture
  identity(root)
  await status(session)
  git(root, 'switch', '--quiet', '--orphan', 'unborn')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(root, 'first.txt'), 'First commit\n')
  await act(session, { kind: 'create', branch: 'initial-branch', base: 'refs/heads/unborn' })
  await act(session, { kind: 'commit', title: 'First commit', body: '', files: ['first.txt'] })
  expect(git(root, 'ls-tree', '--name-only', 'HEAD').trim()).toBe('first.txt')
  writeFileSync(join(root, 'remove.txt'), 'Remove me\n')
  git(root, 'add', 'remove.txt')
  git(root, 'commit', '--quiet', '-m', 'Prepare deletion')
  git(root, 'mv', 'first.txt', 'renamed.txt')
  git(root, 'rm', 'remove.txt')
  writeFileSync(join(root, 'addition.txt'), 'New addition\n')
  writeFileSync(join(root, 'excluded.txt'), 'Keep staged\n')
  git(root, 'add', 'excluded.txt')
  await act(session, {
    kind: 'commit',
    title: 'Selected file operations',
    body: '',
    files: ['renamed.txt', 'remove.txt', 'addition.txt'],
  })
  expect(git(root, 'ls-tree', '--name-only', 'HEAD').trim().split('\n')).toEqual([
    'addition.txt',
    'renamed.txt',
  ])
  expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('excluded.txt')
})
