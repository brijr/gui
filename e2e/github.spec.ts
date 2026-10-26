import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { git } from './helpers/fixtures'
import { expect, test } from './helpers/test'

test('signed-out Projects opens without accessing Keychain', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await session.app.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => {
      throw new Error('Projects must not access Keychain without a saved session')
    }
  })
  await session.chrome.evaluate(() => window.gui.openSettings('github'))
  await expect
    .poll(() =>
      session.app
        .context()
        .pages()
        .some((page) => page.url().endsWith('/settings.html')),
    )
    .toBe(true)
  const page = session.app
    .context()
    .pages()
    .find((page) => page.url().endsWith('/settings.html'))
  if (!page) throw new Error('Settings did not open')
  await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible()
})

test('GitHub connects to the Gui account, lists repositories, and disconnects', async ({
  launch,
}) => {
  let connected = false
  let loopback = 0
  let createdName = ''
  const readBody = (request: import('node:http').IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let body = ''
      request.on('data', (part) => {
        body += part
      })
      request.on('end', () => resolve(body ? JSON.parse(body) : {}))
    })
  const server = createServer((request, response) => {
    const reply = (body: unknown) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
    }
    if (request.url === '/auth/start')
      return void readBody(request).then((body) => {
        // Connecting adds GitHub to the signed-in account.
        expect(request.headers.authorization).toBe(`Bearer ${'b'.repeat(72)}`)
        loopback = Number(body.port)
        reply({ attempt: 'a'.repeat(72), id: 'public', expiresAt: Date.now() + 60_000 })
      })
    if (request.url === '/auth/token') {
      connected = true
      return reply({ session: null })
    }
    if (request.url === '/account')
      return reply({
        account: {
          email: 'tester@example.com',
          name: 'Gui Tester',
          updates: false,
        },
        profile: connected
          ? { login: 'gui-tester', name: 'Gui Tester', email: 'tester@example.com', updates: false }
          : null,
        installUrl: 'https://github.com/apps/gui-test/installations/new',
      })
    if (request.url === '/github' && request.method === 'DELETE') {
      connected = false
      return reply({ ok: true })
    }
    if (request.url === '/repositories' && request.method === 'POST')
      return void readBody(request).then((body) => {
        createdName = String(body.name)
        reply({ repository: { id: 2, fullName: `gui-tester/${createdName}`, private: true } })
      })
    if (request.url === '/repositories')
      return reply({
        repositories: [{ id: 1, fullName: 'gui-tester/private-project', private: true }],
      })
    if (request.url === '/repositories/1/credential')
      return reply({ token: 'test-provider-secret', fullName: 'gui-tester/private-project' })
    if (request.url === '/repositories/1/pulls')
      return reply({ url: 'https://github.com/gui-tester/private-project/pull/1' })
    response.statusCode = 404
    reply({ error: 'Not found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  const previous = process.env.GUI_ACCOUNTS_URL
  process.env.GUI_ACCOUNTS_URL = `http://127.0.0.1:${address.port}`
  try {
    const session = await launch({ fixture: 'vite' })
    await session.waitForPreview()
    // No browser navigation or keychain prompt in tests. Production uses Electron secure storage.
    // Already signed in to Gui, as everyone is by the time they reach Settings.
    await session.app.evaluate(({ app, shell, safeStorage }) => {
      shell.openExternal = async () => undefined
      safeStorage.isEncryptionAvailable = () => true
      safeStorage.encryptString = (value) => Buffer.from(`test-encrypted:${value}`)
      safeStorage.decryptString = (value) => value.toString().replace(/^test-encrypted:/, '')
      const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
      const path = process.getBuiltinModule('path') as typeof import('node:path')
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'github-session'),
        `test-encrypted:${'b'.repeat(72)}`,
      )
    })
    await session.chrome.evaluate(() => window.gui.openSettings('github'))
    let page = session.app
      .context()
      .pages()
      .find((item) => item.url().endsWith('/settings.html'))
    await expect
      .poll(() => {
        page = session.app
          .context()
          .pages()
          .find((item) => item.url().endsWith('/settings.html'))
        return !!page
      })
      .toBe(true)
    if (!page) throw new Error('Settings did not open')
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click()
    await expect(page.getByText('Finish connecting in your browser')).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('github-connecting.png') })
    // The browser, back from GitHub, lands on Gui's loopback with the one-time code.
    await expect.poll(() => loopback).toBeGreaterThan(0)
    const landing = await fetch(`http://127.0.0.1:${loopback}/callback?code=one-time`)
    expect(await landing.text()).toContain('GitHub is connected')
    await expect(page.getByText('@gui-tester', { exact: true })).toBeVisible()
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'gui-tester/private-project' })
        .getByText('Private', { exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Clone & open' })).toBeVisible()
    await page.getByLabel('Repository name', { exact: true }).fill('design-project')
    await page.getByRole('button', { name: 'Create private repository', exact: true }).click()
    await expect.poll(() => createdName).toBe('design-project')
    await expect(page.getByText('Created gui-tester/design-project.')).toBeVisible()
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: 'gui-tester/design-project' })
        .getByText('Private', { exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('github-connected.png') })
    const userData = await session.app.evaluate(({ app }) => app.getPath('userData'))
    expect(readFileSync(join(userData, 'github-session')).toString()).toContain('test-encrypted:')
    const cloneParent = session.fixture.base
    await session.app.evaluate(({ dialog }, parent) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] })
    }, cloneParent)
    // Existing folders survive a rejected clone.
    const destination = join(cloneParent, 'private-project')
    mkdirSync(destination)
    writeFileSync(join(destination, 'keep.txt'), 'existing project')
    await page
      .getByRole('listitem')
      .filter({ hasText: 'gui-tester/private-project' })
      .getByRole('button', { name: 'Clone & open' })
      .click()
    await expect(page.getByRole('alert')).toContainText('EEXIST')
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('existing project')
    rmSync(destination, { recursive: true })
    // Replace only git clone, so the test can inspect credentials and fail without contacting GitHub.
    await session.app.evaluate(() => {
      const child = process.getBuiltinModule('child_process') as typeof import('node:child_process')
      const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
      const original = child.execFile
      child.execFile = ((...args: unknown[]) => {
        const [command, argv, options, callback] = args as [
          string,
          string[],
          { env: Record<string, string> },
          (error: Error) => void,
        ]
        if (command === 'git' && argv.includes('credential.helper=')) {
          ;(globalThis as unknown as { cloneInspection: unknown }).cloneInspection = {
            argv,
            token: options.env.GUI_GIT_TOKEN,
            askpass: options.env.GIT_ASKPASS,
            script: fs.readFileSync(options.env.GIT_ASKPASS, 'utf8'),
          }
          if (argv.includes('push')) callback(null as unknown as Error)
          else callback(new Error('test-provider-secret must never appear in the renderer error'))
          return
        }
        return original(...(args as Parameters<typeof original>))
      }) as typeof original
      process.getBuiltinModule('module').syncBuiltinESMExports()
    })
    await page
      .getByRole('listitem')
      .filter({ hasText: 'gui-tester/private-project' })
      .getByRole('button', { name: 'Clone & open' })
      .click()
    await expect(page.getByRole('alert')).toContainText(
      'Could not clone gui-tester/private-project',
    )
    await expect(page.getByRole('alert')).not.toContainText('test-provider-secret')
    const inspection = await session.app.evaluate(
      () =>
        (
          globalThis as unknown as {
            cloneInspection: { argv: string[]; token: string; askpass: string; script: string }
          }
        ).cloneInspection,
    )
    expect(inspection.token).toBe('test-provider-secret')
    expect(inspection.argv.join(' ')).not.toContain('test-provider-secret')
    expect(inspection.script).not.toContain('test-provider-secret')
    expect(existsSync(inspection.askpass)).toBe(false)
    expect(existsSync(destination)).toBe(false)
    // Connected projects ship with the GitHub session instead of a gh login.
    const root = session.fixture.root
    git(root, 'branch', '-M', 'main')
    git(root, 'remote', 'add', 'origin', 'https://github.com/gui-tester/private-project.git')
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git(root, 'config', 'user.name', 'Existing Designer')
    git(root, 'config', 'user.email', 'existing@example.com')
    git(root, 'config', 'commit.gpgsign', 'false')
    git(root, 'config', 'core.hooksPath', '/dev/null')
    appendFileSync(join(root, 'src/App.tsx'), '\n// GitHub connected shipping\n')
    const result = await session.chat.evaluate(() =>
      window.gui.ship({
        branch: 'gui/design-test',
        title: 'Design update',
        body: 'Reviewed design changes',
      }),
    )
    expect(result).toMatchObject({
      outcome: 'created',
      url: 'https://github.com/gui-tester/private-project/pull/1',
    })
    expect(git(root, 'log', '-1', '--format=%an <%ae>').trim()).toBe(
      'Existing Designer <existing@example.com>',
    )
    expect(git(root, 'config', 'branch.gui/design-test.remote').trim()).toBe('origin')
    const pushInspection = await session.app.evaluate(
      () =>
        (
          globalThis as unknown as {
            cloneInspection: { argv: string[]; token: string; askpass: string; script: string }
          }
        ).cloneInspection,
    )
    expect(pushInspection.argv).toContain('https://github.com/gui-tester/private-project.git')
    // The exact commit Gui checked goes up, so a commit made meanwhile can't ride along.
    const shipped = git(root, 'rev-parse', 'gui/design-test').trim()
    expect(pushInspection.argv).toContain(`${shipped}:refs/heads/gui/design-test`)
    expect(pushInspection.argv.join(' ')).not.toContain('test-provider-secret')
    expect(existsSync(pushInspection.askpass)).toBe(false)
    // A project's untrusted preview cannot call account methods through IPC.
    const preview = await session.previewPage()
    expect(await preview.evaluate(() => 'gui' in window)).toBe(false)
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible()
    expect(connected).toBe(false)
    // Disconnecting GitHub leaves Gui signed in.
    expect(existsSync(join(userData, 'github-session'))).toBe(true)
    await page.screenshot({ path: test.info().outputPath('github-disconnected.png') })
    // The start screen's GitHub projects opens them in Settings, beside Clone by URL.
    await session.chrome.evaluate(() => window.gui.newTab())
    await expect(
      session.chrome.getByRole('button', { name: 'Clone by URL', exact: true }),
    ).toBeVisible()
    await session.chrome.screenshot({ path: test.info().outputPath('github-start-screen.png') })
    await session.chrome.getByRole('button', { name: 'Connect GitHub…', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible()
  } finally {
    if (previous === undefined) delete process.env.GUI_ACCOUNTS_URL
    else process.env.GUI_ACCOUNTS_URL = previous
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
