import { type ComponentType, type FormEvent, useEffect, useId, useRef, useState } from 'react'
import type { SignInProvider } from '../../../shared/account'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { Field, InlineError, Input } from '../lib/field'
import { GitHubMark } from '../lib/github-mark'
import { GuiMark } from '../lib/gui-mark'
import { AppleMark, GoogleMark } from '../lib/provider-marks'
import { Button, Checkbox, Spinner, TextButton } from '../lib/ui'

const PROVIDERS: readonly { id: SignInProvider; label: string; mark: ComponentType }[] = [
  { id: 'google', label: 'Continue with Google', mark: GoogleMark },
  { id: 'apple', label: 'Continue with Apple', mark: AppleMark },
  { id: 'github', label: 'Continue with GitHub', mark: GitHubMark },
]

const CANCELLED = 'Sign-in was cancelled.'

type Step =
  | { kind: 'choose' }
  | { kind: 'browser'; provider: SignInProvider }
  | { kind: 'email'; email: string }

/**
 * The start screen until there's a Gui account: Google, Apple, or GitHub in the browser, or
 * a link and code by email. Once signed in, main tells every window and this goes away.
 */
export function SignIn() {
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [email, setEmail] = useState('')
  const [updates, setUpdates] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The product-update choice, for when signing in finishes (by the browser or the email).
  const wantsUpdates = useRef(updates)
  wantsUpdates.current = updates

  const signedIn = () => {
    if (wantsUpdates.current) void gui.setAccountUpdates(true).catch(() => undefined)
  }
  const failed = (err: unknown) => {
    const message = readableError(err)
    if (message !== CANCELLED) setError(message)
    setStep({ kind: 'choose' })
  }

  const continueWith = (provider: SignInProvider) => {
    setError(null)
    setStep({ kind: 'browser', provider })
    gui.accountSignIn(provider).then(signedIn, failed)
  }

  const sendEmail = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !email.trim()) return
    setBusy(true)
    setError(null)
    try {
      await gui.accountEmail(email.trim())
      setStep({ kind: 'email', email: email.trim() })
      // The link, opened on this Mac, finishes it as well as the code does.
      gui.waitForAccount().then(signedIn, failed)
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    setError(null)
    setStep({ kind: 'choose' })
    void gui.cancelAccountSignIn().catch(() => undefined)
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="flex flex-col gap-1">
        <GuiMark animated className="mb-4" />
        <h1 className="text-title font-semibold">Sign in to Gui</h1>
        <p className="text-pretty text-muted">
          Use your Gui account to design your app with your own agents. New here? Signing in makes
          one.
        </p>
      </div>

      {step.kind === 'browser' ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="flex items-center gap-2 text-muted">
            <Spinner />
            Finish signing in in your browser…
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => continueWith(step.provider)}>Open browser again</Button>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : step.kind === 'email' ? (
        <EmailCode email={step.email} onSignedIn={signedIn} onBack={cancel} />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {PROVIDERS.map(({ id, label, mark: Mark }) => (
              <Button
                key={id}
                size="lg"
                className="w-full justify-start"
                disabled={busy}
                onClick={() => continueWith(id)}
              >
                <Mark />
                {label}
              </Button>
            ))}
          </div>
          <form className="flex flex-col gap-2" onSubmit={(event) => void sendEmail(event)}>
            <Field label="Or use your email" htmlFor="sign-in-email">
              <Input
                id="sign-in-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                maxLength={254}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={busy}
              disabled={!email.trim()}
            >
              Email me a sign-in link
            </Button>
          </form>
        </>
      )}

      {error && <InlineError>{error}</InlineError>}

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Checkbox
          label="Email me about new Gui features"
          checked={updates}
          onChange={(event) => setUpdates(event.target.checked)}
        />
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
          .
        </p>
      </div>
    </div>
  )
}

/** Email sent: the code from it, typed here, or its link opened on this Mac. */
function EmailCode({
  email,
  onSignedIn,
  onBack,
}: {
  email: string
  onSignedIn: () => void
  onBack: () => void
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  useEffect(() => input.current?.focus(), [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || code.replace(/\D/g, '').length !== 6) return
    setBusy(true)
    setError(null)
    try {
      await gui.accountCode(code)
      onSignedIn()
    } catch (err) {
      setError(readableError(err))
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <div className="flex flex-col gap-1">
        <p className="font-semibold">Check your email</p>
        <p id={hintId} className="text-pretty text-muted">
          Gui sent a link to <span className="text-fg">{email}</span>. Open it on this Mac, or enter
          the 6-digit code from the email.
        </p>
      </div>
      <Input
        ref={input}
        aria-label="Code from the email"
        aria-describedby={hintId}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        mono
        maxLength={7}
        value={code}
        disabled={busy}
        onChange={(event) => setCode(event.target.value)}
      />
      {error && <InlineError>{error}</InlineError>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={code.replace(/\D/g, '').length !== 6}
        >
          Sign in
        </Button>
        <TextButton tone="muted" onClick={onBack}>
          Use another way to sign in
        </TextButton>
      </div>
    </form>
  )
}
