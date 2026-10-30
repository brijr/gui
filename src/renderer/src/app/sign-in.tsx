import { useState } from 'react'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { GuiMark } from '../lib/gui-mark'
import { Button, Spinner } from '../lib/ui'

const CANCELLED = 'Sign-in was cancelled.'

/**
 * The start screen until there's a Gui account. Signing in happens in the browser, on WorkOS
 * AuthKit (Google, GitHub, or email); once it's done, main tells every window and this
 * goes away.
 */
export function SignIn() {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = () => {
    setError(null)
    setWaiting(true)
    gui.accountSignIn().catch((err: unknown) => {
      const message = readableError(err)
      if (message !== CANCELLED) setError(message)
      setWaiting(false)
    })
  }

  const cancel = () => {
    setError(null)
    setWaiting(false)
    void gui.cancelAccountSignIn().catch(() => undefined)
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="flex flex-col gap-1">
        <GuiMark className="mb-4" />
        <h1 className="text-title font-semibold">Sign in to Gui</h1>
        <p className="text-pretty text-muted">
          Use your Gui account to design your app with your own agents. Sign in with Google, GitHub,
          or your email. New here? Signing in makes an account.
        </p>
        <p className="text-pretty text-small text-muted">
          Gui is free during alpha. Your AI agent uses your own account and plan.
        </p>
      </div>

      {waiting ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="flex items-center gap-2 text-muted">
            <Spinner />
            Continue in your browser to sign in…
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={signIn}>Open browser again</Button>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="primary" size="lg" className="self-start" onClick={signIn}>
          Sign in or create an account
        </Button>
      )}

      {error && <InlineError>{error}</InlineError>}

      <div className="border-t border-line pt-4">
        <p className="text-pretty text-small text-subtle">
          By continuing, you agree to Gui’s{' '}
          <a
            className="underline underline-offset-2"
            href="https://usegui.com/terms"
            target="_blank"
            rel="noreferrer"
          >
            Terms
          </a>{' '}
          and{' '}
          <a
            className="underline underline-offset-2"
            href="https://usegui.com/privacy"
            target="_blank"
            rel="noreferrer"
          >
            Privacy Policy
          </a>
          . Product emails are optional. You can choose them in Settings → Account.
        </p>
      </div>
    </div>
  )
}
