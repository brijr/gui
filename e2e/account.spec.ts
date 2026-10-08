import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { expect, test } from './helpers/test'

const SESSION = 's'.repeat(72)

/** The account service as Gui sees it: sign-in attempts and an account. */
function accountService() {
  const service = {
    port: 0,
    loopback: 0,
    starts: 0,
    updates: false,
    signedOut: false,
  }
  const readBody = (request: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let body = ''
      request.on('data', (part) => {
        body += part
      })
      request.on('end', () => resolve(body ? JSON.parse(body) : {}))
    })
  const server = createServer((request, response) => {
    const reply = (body: unknown, status = 200) => {
      response.statusCode = status
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
    }
    void readBody(request).then((body) => {
      if (request.url === '/auth/start') {
        service.starts++
        service.loopback = Number(body.port)
        return reply({ attempt: 'a'.repeat(72), id: 'public', expiresAt: Date.now() + 60_000 })
      }
      if (request.url === '/auth/token')
        return body.code === 'one-time'
          ? reply({ session: SESSION })
          : reply({ error: 'Sign-in did not finish. Try again.' }, 401)
      if (request.url === '/auth/cancel') return reply({ ok: true })
      if (request.url === '/account/updates') {
        service.updates = body.updates === true
        return reply({ ok: true })
      }
      if (request.url === '/logout') {
        service.signedOut = true
        return reply({ ok: true })
      }
      if (request.url === '/account')
        return reply({
          account: {
            email: 'designer@example.com',
            name: 'Designer',
            updates: service.updates,
          },
          profile: null,
        })
      reply({ error: 'Not found' }, 404)
    })
  })
  return {
    service,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          service.port = address && typeof address === 'object' ? address.port : 0
          resolve(`http://127.0.0.1:${service.port}`)
        }),
      ),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('a new user signs in before Gui opens a project, then the project opens', async ({
  launch,
}) => {
  const fake = accountService()
  const url = await fake.listen()
  try {
    // GUI_OPEN asks for the project at launch, as the `gui` command or the Dock would.
    const session = await launch({
      fixture: 'vite',
      env: { GUI_ACCOUNTS_URL: url, GUI_ACCOUNT_REQUIRED: '1' },
    })
    await session.app.evaluate(({ shell, safeStorage }) => {
      ;(globalThis as unknown as { opened: string[] }).opened = []
      shell.openExternal = async (target) => {
        ;(globalThis as unknown as { opened: string[] }).opened.push(target)
      }
      safeStorage.isEncryptionAvailable = () => true
      safeStorage.encryptString = (value) => Buffer.from(`test-encrypted:${value}`)
      safeStorage.decryptString = (value) => value.toString().replace(/^test-encrypted:/, '')
    })
    const chrome = session.chrome
    await expect(chrome.getByRole('heading', { name: 'Sign in to Gui' })).toBeVisible()
    await expect(chrome.getByRole('button', { name: 'Open project…' })).toHaveCount(0)
    await chrome.screenshot({ path: test.info().outputPath('sign-in.png') })

    // Product updates are a choice, off until made.
    const updates = chrome.getByRole('checkbox', { name: 'Email me about new Gui features' })
    await expect(updates).not.toBeChecked()
    await updates.check()
    await chrome.getByRole('button', { name: 'Sign in or create an account' }).click()
    await expect(chrome.getByText('Finish signing in in your browser…')).toBeVisible()
    const opened = await session.app.evaluate(
      () => (globalThis as unknown as { opened: string[] }).opened,
    )
    expect(opened).toEqual([`${url}/signin/workos?a=public`])

    // The browser comes back to Gui's loopback with a one-time code.
    const landing = await fetch(`http://127.0.0.1:${fake.service.loopback}/callback?code=one-time`)
    expect(await landing.text()).toContain('You’re signed in to Gui')
    await session.waitForPreview()
    await expect.poll(() => fake.service.updates).toBe(true)
    const userData = await session.app.evaluate(({ app }) => app.getPath('userData'))
    expect(existsSync(join(userData, 'github-session'))).toBe(true)
  } finally {
    await fake.close()
  }
})

test('a sign-in that fails says so; cancelling and signing out ask again', async ({ launch }) => {
  const fake = accountService()
  const url = await fake.listen()
  try {
    const session = await launch({
      fixture: 'vite',
      open: 'recent',
      env: { GUI_ACCOUNTS_URL: url, GUI_ACCOUNT_REQUIRED: '1' },
    })
    await session.app.evaluate(({ shell, safeStorage }) => {
      shell.openExternal = async () => undefined
      safeStorage.isEncryptionAvailable = () => true
      safeStorage.encryptString = (value) => Buffer.from(`test-encrypted:${value}`)
      safeStorage.decryptString = (value) => value.toString().replace(/^test-encrypted:/, '')
    })
    const chrome = session.chrome
    const signIn = chrome.getByRole('button', { name: 'Sign in or create an account' })

    // Cancelling goes back without an error.
    await signIn.click()
    await chrome.getByRole('button', { name: 'Cancel' }).click()
    await expect(signIn).toBeVisible()
    await expect(chrome.getByRole('alert')).toHaveCount(0)

    // A code the service refuses ends the attempt with its message.
    await signIn.click()
    await expect(chrome.getByText('Finish signing in in your browser…')).toBeVisible()
    const refused = await fetch(`http://127.0.0.1:${fake.service.loopback}/callback?code=stale`)
    expect(await refused.text()).toContain('Sign-in didn’t finish')
    await expect(chrome.getByRole('alert')).toContainText('Sign-in did not finish')

    await signIn.click()
    await fetch(`http://127.0.0.1:${fake.service.loopback}/callback?code=one-time`)
    await expect(chrome.getByRole('button', { name: 'Open project…' })).toBeVisible()
    // Nobody asked for updates, so none were turned on.
    expect(fake.service.updates).toBe(false)

    // Settings → Account signs out, and the start screen asks again.
    await chrome.evaluate(() => window.gui.openSettings('account'))
    await expect
      .poll(() =>
        session.app
          .context()
          .pages()
          .some((page) => page.url().endsWith('/settings.html')),
      )
      .toBe(true)
    const settings = session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/settings.html'))
    if (!settings) throw new Error('Settings did not open')
    await expect(settings.getByText('designer@example.com')).toBeVisible()
    await settings.getByRole('button', { name: 'Sign out' }).click()
    await expect.poll(() => fake.service.signedOut).toBe(true)
    await expect(chrome.getByRole('heading', { name: 'Sign in to Gui' })).toBeVisible()
  } finally {
    await fake.close()
  }
})
