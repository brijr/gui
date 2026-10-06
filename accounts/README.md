# Gui accounts

The account service supports GitHub project connections. Local projects do not require an account. It stores profile and verified primary email centrally, with an explicit product-update opt-in. It does not send email.

## Local development

Install the root dependencies and run `bun install` inside `accounts/`. Register a development GitHub App with device flow enabled and these permissions:

- Account email addresses: read-only.
- Repository contents: read and write.
- Repository pull requests: read and write.
- Repository administration: read and write (required for repository creation; also permits broader repository administration).
- Repository metadata: read-only.

Enable expiring user access tokens. Enter its client ID and app slug in a local Wrangler configuration or `.dev.vars`. Add `GITHUB_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` to `.dev.vars`. The encryption key must be 64 hexadecimal characters from a cryptographically random 32-byte value. Keep this file out of Git. Changing the key without migrating encrypted records makes existing connections unreadable.

Run `bun run migrate:local` and `bun run dev` from `accounts/`. Start the desktop from the repository root with `GUI_ACCOUNTS_URL=http://127.0.0.1:8787 bun run dev`.

The registered app must allow installation by the intended users. A user authorizes their identity through the browser device flow, then installs the app on selected repositories. Organization approval and SSO can delay access. Refresh repositories after installation. Gui lists only repositories accessible to both the user and app.

## Production activation

The `Gui Projects` GitHub App is registered under `brijr`, and the `gui-accounts` D1 database and schema exist in the WIP Cloudflare account. `wrangler.jsonc` contains their public identifiers. The Worker code, DB binding, login rate limiter, public app identifiers, and encrypted server secrets are deployed at `https://gui-accounts.brijr.workers.dev`. Live device authorization, attempt storage, cancellation, sign-in from the installed Gui app, and connected repository listing have been verified. Live repository creation, cloning, and shipping remain unverified. Configure the Worker hostname and rate-limit namespace for the intended account. Keep deployment and remote migration authorization separate from local implementation.

The desktop defaults to `https://gui-accounts.brijr.workers.dev`. To use a different service, build with `GUI_ACCOUNTS_URL=https://YOUR-ACCOUNT-SERVICE bun run build`. The production service origin is embedded at build time; a packaged app does not accept a runtime override. Builds without an origin show that GitHub connections are unavailable and retain cloning by URL.

Validate live sign-in, private-repository cloning, revoked access, and token refresh with an authorized test account before shipping. Automated checks use provider and keychain stand-ins. They do not prove live GitHub credentials, macOS keychain access, or production behavior.

## Creating and managing projects

The connection UI creates private repositories under the signed-in personal account, initialized with a README. The user must install Gui on their personal GitHub account first. Creation and cloning are separate actions, so canceling or failing a local clone never deletes the repository. Name conflicts are surfaced without retrying creation automatically. Organization repository creation and merging are outside this flow.

The existing shipping sheet reviews a branch, title, description, and files before committing, pushing, and opening a pull request. The service checks repository access again for credentials and PR creation. Existing open PRs are reused. GitHub write access still depends on both the user and installed app, and branch protection continues to apply.

## Contact information

Authorized operators can read contact information using the database's existing access controls. There is no public customer export endpoint. Select only `login`, `name`, `email`, and `preference_changed_at` from `users` where `updates = 1 AND email IS NOT NULL` for a product-update recipient list. Do not export provider tokens or Gui sessions. Preferences default to off and survive repeat sign-in by GitHub numeric identity.

Sign-in refreshes the saved name, handle, and verified primary email. Disconnect signs out the current device; it preserves the hosted profile and email preference. Repository permissions are managed on GitHub. The authenticated `DELETE /account` endpoint removes the account and all Gui sessions; GitHub authorization itself must be revoked on GitHub separately.

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
