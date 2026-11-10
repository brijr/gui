# Gui accounts

Gui requires an account before it opens a project. People sign in on WorkOS AuthKit's hosted page, which offers Google, GitHub or email; which of these appear, and the page's look, are set in the WorkOS dashboard. The worker turns the WorkOS user into a Gui account, so a verified email that matches an existing account joins it (that's how GitHub users from before keep their accounts). GitHub can also be connected to an account for cloning; that's Gui's own GitHub App, separate from signing in with GitHub. The service stores the name, the email, and a product-update choice that starts on for new accounts with an email, as the terms say.

## Sign-in flow

1. Gui listens on a loopback port and calls `POST /auth/start` with it. The response is a secret attempt token, which Gui keeps, and a public ID.
2. Gui opens `/signin/workos?a=ID` in the browser. The worker sends the browser to AuthKit with a single-use state.
3. AuthKit returns to `/callback/workos`. The worker trades the code for the WorkOS user, ends the WorkOS session (Gui keeps its own, and signing in again should ask again), finds or creates the account, and sends the browser to `http://127.0.0.1:PORT/callback?code=…`.
4. Gui trades that one-time code, with its attempt token, for a session at `POST /auth/token`.

A sign-in link opened by someone else cannot sign in this Gui. Their browser returns to their own computer, and only this Gui holds the attempt token.

Connecting GitHub in Settings uses the same flow, started with the session, through `/signin/github` and `/callback/github`. GitHub joins the signed-in account and no new session is made; GitHub in the browser can't start a sign-in. The old device-flow routes (`/github/start`, `/github/poll`) remain for Gui versions that still use them.

## Setup

Signing in stays unavailable, with a page that says so, until WorkOS is configured. Callback URLs use the host that Gui's build uses (`SERVICE`).

- **WorkOS:** in the production environment, add `https://SERVICE/callback/workos` as a redirect URI. Set the client ID as the `WORKOS_CLIENT_ID` var and the API key as the `WORKOS_API_KEY` secret. Turn on the sign-in methods under Authentication. WorkOS's own Google and GitHub credentials only work in staging: production needs an OAuth app with each provider, registered with the redirect URI WorkOS shows for it. Magic Auth (email codes) needs nothing more.
- **GitHub connection:** add `https://SERVICE/callback/github` as a callback URL on the existing `Gui Projects` app. For cloning, set the app's ID as the `GITHUB_APP_ID` var and a private key generated on its settings page (the downloaded `.pem`, as is) as the `GITHUB_APP_PRIVATE_KEY` secret. Gui then gets a token for one repository's contents, valid for an hour, rather than the user's own token, which reaches every connected repository with every permission the app has. Without them, cloning through Gui is unavailable.

Apply the migrations in order before deploying. `0002_gui_accounts.sql` turns every GitHub user into an account with GitHub as its sign-in, and keeps existing sessions; product updates stay on only for people who chose them in Settings. `0003_workos.sql` makes WorkOS the way to sign in, keeping GitHub identities from the device flow, and clears sign-ins in progress.

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

The `Gui Projects` GitHub App is registered under `brijr`, and the `gui-accounts` D1 database and schema exist in the WIP Cloudflare account. `wrangler.jsonc` contains their public identifiers. The Worker code, DB binding, login rate limiter, public app identifiers, and encrypted server secrets are deployed at `https://gui-accounts.brijr.workers.dev`. Live device authorization, attempt storage, cancellation, sign-in from the installed Gui app, and connected repository listing have been verified with the earlier GitHub-only service. `0002_gui_accounts.sql` was applied on 2026-10-08, after `0001` was recorded as applied because the schema had been created by hand. A backup from before the migration is kept outside the repository. The account worker is deployed at `https://accounts.usegui.com`. Sign-in through WorkOS has not been configured or verified end to end, and connecting GitHub through the browser needs its callback URL on the app. Live private cloning remains unverified. Configure the Worker hostname and rate-limit namespace for the intended account. Keep deployment and remote migration authorization separate from local implementation.

The desktop defaults to `https://accounts.usegui.com`. Earlier builds use `https://gui-accounts.brijr.workers.dev`, which stays enabled for them. To use a different service, build with `GUI_ACCOUNTS_URL=https://YOUR-ACCOUNT-SERVICE bun run build`. The production service origin is embedded at build time; a packaged app does not accept a runtime override. Builds without an origin do not require an account, show that GitHub connections are unavailable, and retain cloning by URL. The WorkOS and GitHub callback URLs use this origin, so choose the final hostname before you register them.

Validate live sign-in, private-repository cloning, revoked access, and token refresh with an authorized test account before shipping. Automated checks use provider and keychain stand-ins. They do not prove live GitHub credentials, macOS keychain access, or production behavior.

## Creating and managing projects

Gui's connection UI no longer creates repositories: **Clone…** on the start screen and **Settings → GitHub** only connect GitHub, choose repositories and clone one. The service still has a route that creates private repositories under the signed-in personal account, initialized with a README; the app doesn't call it. The user must install Gui on their personal GitHub account first. Creation and cloning are separate actions, so canceling or failing a local clone never deletes the repository. Name conflicts are surfaced without retrying creation automatically. Organization repository creation and merging are outside this flow.

The existing shipping sheet reviews a branch, title, description, and files before committing, pushing, and opening a pull request. The service checks repository access again for credentials and PR creation. Existing open PRs are reused. GitHub write access still depends on both the user and installed app, and branch protection continues to apply.

## Contact information

Authorized operators can read contact information using the database's existing access controls. There is no public customer export endpoint. For a product-update recipient list, select only `name`, `email`, and `preference_changed_at` from `accounts` where `updates = 1 AND email IS NOT NULL`. Do not export provider tokens or Gui sessions. New accounts start with updates off; people can opt in in Settings → Account, and the choice survives repeat sign-in. Accounts made before this change keep their own choice.

An account keeps its first email and name. Sign-in only fills them if they are missing. Signing out in Settings → Account ends that device's session. Disconnecting GitHub removes the GitHub tokens. Sessions last 180 days, and active use extends them. The authenticated `DELETE /account` endpoint removes the account, its identities, its GitHub connection, and all Gui sessions. GitHub authorization itself must be revoked on GitHub separately.

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
