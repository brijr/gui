# Gui accounts

Gui requires an account before it opens a project. People sign in with Google, Apple, GitHub, or an emailed link and code (Cloudflare Email Service). Each way of signing in is an identity on one account; a verified email that matches an existing account joins it. GitHub can also be connected to an account for repositories, cloning, and pull requests. The service stores the name, the email, and a product-update choice that is off until the person turns it on.

## Sign-in flow

1. Gui listens on a loopback port and calls `POST /auth/start` with it. The response is a secret attempt token, which Gui keeps, and a public ID.
2. Gui opens `/signin/{google|apple|github}?a=ID` in the browser. The worker sends the browser to the provider with a single-use state.
3. The provider returns to `/callback/{provider}`. Apple posts its result. The worker finds or creates the account and sends the browser to `http://127.0.0.1:PORT/callback?code=…`.
4. Gui trades that one-time code, with its attempt token, for a session at `POST /auth/token`.

A sign-in link forwarded to someone else cannot sign in the sender's Gui. The other person's browser returns to their own computer, and only the sender's Gui holds the attempt token.

Email works the same way. `POST /auth/email` sends a link and a 6-digit code. The link opens a page with a button, so mail scanners that open links do not sign anyone in. Confirming continues as in step 3. The code is typed into Gui instead (`POST /auth/email/code`), for email read on another device. A sign-in allows 3 emails and 5 code tries. `EMAIL_LIMITER` limits emails to each address.

Connecting GitHub in Settings uses the same flow, started with the session. The identity joins the signed-in account and no new session is made. The old device-flow routes (`/github/start`, `/github/poll`) remain for Gui versions that still use them.

## Provider setup

Each provider stays unavailable, with a page that says so, until its settings exist. Callback URLs are `https://SERVICE/callback/{provider}`, on the host that Gui's build uses.

- **GitHub:** add `https://SERVICE/callback/github` as a callback URL on the existing `Gui Projects` app. For pushing and pulling, set the app's ID as the `GITHUB_APP_ID` var and a private key generated on its settings page (the downloaded `.pem`, as is) as the `GITHUB_APP_PRIVATE_KEY` secret. Gui then gets a token for one repository's contents and pull requests, valid for an hour, rather than the user's own token, which reaches every connected repository with every permission the app has. Without them, Gui pushes with the user's own git or `gh` instead.
- **Google:** create an OAuth client of type *Web application* with that redirect URI. Set `GOOGLE_CLIENT_ID` as a var and `GOOGLE_CLIENT_SECRET` as a secret. The consent screen needs the `openid`, `email`, and `profile` scopes, and must be published before it can be used outside test users.
- **Apple:** create a Services ID, which becomes `APPLE_CLIENT_ID`, with Sign in with Apple enabled. Register the service domain and return URL. Create a Sign in with Apple key. Set `APPLE_TEAM_ID` and `APPLE_KEY_ID` as vars, and the `.p8` contents as the `APPLE_PRIVATE_KEY` secret.
- **Email:** onboard `usegui.com` for Cloudflare Email Sending (`npx wrangler email sending enable usegui.com`). The `send_email` binding `EMAIL` and `EMAIL_FROM` are in `wrangler.jsonc`. Email Sending is in beta and requires Workers Paid.

Apply `migrations/0002_gui_accounts.sql` before deploying this worker. It turns every GitHub user into an account with GitHub as its sign-in, and keeps existing sessions. Product updates stay on only for people who chose them in Settings; the rest had been subscribed by default without being asked.

## Local development

Install the root dependencies and run `bun install` inside `accounts/`. Register a development GitHub App with device flow enabled and these permissions:

- Account email addresses: read-only.
- Repository contents: read and write.
- Repository pull requests: read and write.
- Repository administration: read and write (required for repository creation; also permits broader repository administration).
- Repository metadata: read-only.

Enable expiring user access tokens. Enter its client ID, app slug, and app ID (`GITHUB_APP_ID`) in a local Wrangler configuration or `.dev.vars`. Add `GITHUB_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and the app's private key (`GITHUB_APP_PRIVATE_KEY`) to `.dev.vars`. The encryption key must be 64 hexadecimal characters from a cryptographically random 32-byte value. Keep this file out of Git. Changing the key without migrating encrypted records makes existing connections unreadable.

Run `bun run migrate:local` and `bun run dev` from `accounts/`. Start the desktop from the repository root with `GUI_ACCOUNTS_URL=http://127.0.0.1:8787 bun run dev`. Unpackaged builds started with `GUI_ACCOUNT_REQUIRED=0` do not require an account; the end-to-end tests use this setting, except `e2e/account.spec.ts`.

The registered app must allow installation by the intended users. A user authorizes their identity through the browser device flow, then installs the app on selected repositories. Organization approval and SSO can delay access. Refresh repositories after installation. Gui lists only repositories accessible to both the user and app.

## Production activation

The `Gui Projects` GitHub App is registered under `brijr`, and the `gui-accounts` D1 database and schema exist in the WIP Cloudflare account. `wrangler.jsonc` contains their public identifiers. The Worker code, DB binding, login rate limiter, public app identifiers, and encrypted server secrets are deployed at `https://gui-accounts.brijr.workers.dev`. Live device authorization, attempt storage, cancellation, sign-in from the installed Gui app, and connected repository listing have been verified with the earlier GitHub-only service. `0002_gui_accounts.sql` was applied on 2026-10-08, after `0001` was recorded as applied because the schema had been created by hand. A backup from before the migration is kept outside the repository. The account worker is deployed at `https://accounts.usegui.com`, and Email Sending is enabled for `usegui.com`. Google and Apple are not configured yet. GitHub web sign-in needs its callback URL on the app. None of the provider sign-ins or email delivery has been verified end to end. Live repository creation, cloning, and shipping remain unverified. Configure the Worker hostname and rate-limit namespace for the intended account. Keep deployment and remote migration authorization separate from local implementation.

The desktop defaults to `https://accounts.usegui.com`. Earlier builds use `https://gui-accounts.brijr.workers.dev`, which stays enabled for them. To use a different service, build with `GUI_ACCOUNTS_URL=https://YOUR-ACCOUNT-SERVICE bun run build`. The production service origin is embedded at build time; a packaged app does not accept a runtime override. Builds without an origin do not require an account, show that GitHub connections are unavailable, and retain cloning by URL. Provider callback URLs use this origin, so choose the final hostname before you register them.

Validate live sign-in, private-repository cloning, revoked access, and token refresh with an authorized test account before shipping. Automated checks use provider and keychain stand-ins. They do not prove live GitHub credentials, macOS keychain access, or production behavior.

## Creating and managing projects

The connection UI creates private repositories under the signed-in personal account, initialized with a README. The user must install Gui on their personal GitHub account first. Creation and cloning are separate actions, so canceling or failing a local clone never deletes the repository. Name conflicts are surfaced without retrying creation automatically. Organization repository creation and merging are outside this flow.

The existing shipping sheet reviews a branch, title, description, and files before committing, pushing, and opening a pull request. The service checks repository access again for credentials and PR creation. Existing open PRs are reused. GitHub write access still depends on both the user and installed app, and branch protection continues to apply.

## Contact information

Authorized operators can read contact information using the database's existing access controls. There is no public customer export endpoint. For a product-update recipient list, select only `name`, `email`, and `preference_changed_at` from `accounts` where `updates = 1 AND email IS NOT NULL`. Do not export provider tokens or Gui sessions. Preferences default to off, are offered at sign-in and in Settings → Account, and survive repeat sign-in.

An account keeps its first email and name. Sign-in only fills them if they are missing. Signing out in Settings → Account ends that device's session. Disconnecting GitHub removes the GitHub tokens but keeps GitHub as a way to sign in. Sessions last 180 days, and active use extends them. The authenticated `DELETE /account` endpoint removes the account, its identities, its GitHub connection, and all Gui sessions. GitHub authorization itself must be revoked on GitHub separately.

Provider tokens and pending device codes are encrypted in D1 with AES-GCM. Gui session and attempt tokens are hashed in D1. Only the Electron main process sees a provider credential for cloning or pushing. Git receives it through a temporary askpass script and process environment, with credential helpers disabled. The clone remote and arguments contain no token, and error messages exclude git stderr. For connected GitHub repositories, the existing shipping sheet uses this connection to push and create a pull request without requiring `gh` sign-in. It supplies a GitHub noreply identity for commits only when git cannot resolve an existing identity; it does not edit global git settings. The temporary script contains no token and is removed after the operation. Clone failures remove only the new destination Gui reserved.

## Checks

From the repository root:

```sh
bun test accounts/worker.test.ts
bun node_modules/typescript/bin/tsc --noEmit -p accounts/tsconfig.json
bun run typecheck
bun run build
bunx playwright test e2e/github.spec.ts
```
