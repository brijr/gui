import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
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

test('GitHub connects to the Gui account, its repositories clone from Clone…, and it disconnects', async ({
  launch,
}) => {
  let connected = false
  let loopback = 0
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
    if (request.url === '/repositories')
      return reply({
        repositories: [{ id: 1, fullName: 'gui-tester/private-project', private: true }],
      })
    if (request.url === '/repositories/1/credential')
      return reply({ token: 'test-provider-secret', fullName: 'gui-tester/private-project' })
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
    // Settings chooses what Gui can see; cloning is the start screen's Clone….
    await expect(page.getByRole('button', { name: 'Choose on GitHub' })).toBeVisible()
    // Gui no longer makes repositories: Settings only connects and chooses.
    await expect(page.getByLabel('Repository name', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('github-connected.png') })
    const userData = await session.app.evaluate(({ app }) => app.getPath('userData'))
    expect(readFileSync(join(userData, 'github-session')).toString()).toContain('test-encrypted:')
    const cloneParent = session.fixture.base
    await session.app.evaluate(({ dialog }, parent) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] })
    }, cloneParent)
    const destination = join(cloneParent, 'private-project')
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
          callback(new Error('test-provider-secret must never appear in the renderer error'))
          return
        }
        return original(...(args as Parameters<typeof original>))
      }) as typeof original
      process.getBuiltinModule('module').syncBuiltinESMExports()
    })
    // A project's untrusted preview cannot call account methods through IPC.
    const preview = await session.previewPage()
    expect(await preview.evaluate(() => 'gui' in window)).toBe(false)

    // The start screen's Clone… lists the connected repositories above the address field.
    await session.chrome.evaluate(() => window.gui.newTab())
    await session.chrome.getByRole('button', { name: 'Clone…', exact: true }).click()
    const privateRow = session.chrome
      .getByRole('listitem')
      .filter({ hasText: 'gui-tester/private-project' })
    await expect(privateRow.getByText('Private', { exact: true })).toBeVisible()
    await expect(session.chrome.getByLabel('GitHub repository', { exact: true })).toBeVisible()
    await session.chrome.screenshot({ path: test.info().outputPath('github-clone-form.png') })
    // Existing folders survive a rejected clone.
    mkdirSync(destination)
    writeFileSync(join(destination, 'keep.txt'), 'existing project')
    await privateRow.getByRole('button', { name: 'Clone…' }).click()
    await expect(privateRow.getByRole('alert')).toContainText('EEXIST')
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('existing project')
    rmSync(destination, { recursive: true })
    await privateRow.getByRole('button', { name: 'Clone…' }).click()
    await expect(privateRow.getByRole('alert')).toContainText(
      "Couldn't clone gui-tester/private-project",
    )
    await expect(privateRow.getByRole('alert')).not.toContainText('test-provider-secret')
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
    await session.chrome.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible()
    expect(connected).toBe(false)
    // Disconnecting GitHub leaves Gui signed in.
    expect(existsSync(join(userData, 'github-session'))).toBe(true)
    await page.screenshot({ path: test.info().outputPath('github-disconnected.png') })
    // Disconnected, Clone… offers to connect GitHub in place of the list.
    await session.chrome.getByRole('button', { name: 'Clone…', exact: true }).click()
    await expect(
      session.chrome.getByRole('button', { name: 'Connect GitHub', exact: true }),
    ).toBeVisible()
    await expect(session.chrome.getByLabel('GitHub repository', { exact: true })).toBeVisible()
    await session.chrome.screenshot({ path: test.info().outputPath('github-start-screen.png') })
  } finally {
    if (previous === undefined) delete process.env.GUI_ACCOUNTS_URL
    else process.env.GUI_ACCOUNTS_URL = previous
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
