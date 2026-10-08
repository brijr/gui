# GitHub projects and accounts

Gui requires a Gui account, made with Google, Apple, GitHub, or email (see [the account service](../accounts/README.md)). GitHub is also a connection on that account for GitHub projects. Local projects need an account but not GitHub. The GitHub App and D1 database are created. Worker code, database binding, rate limiter, public GitHub identifiers, and encrypted server secrets are deployed at `https://gui-accounts.brijr.workers.dev`. Gui defaults to this service. Live device authorization, attempt storage, cancellation, sign-in from the installed Gui app, and connected repository listing have been verified. Live repository creation, cloning, and shipping remain unverified.

## Journey

1. Sign in to Gui from the start screen. A sign-in with GitHub also connects it.
2. Otherwise, open **Connect GitHub** from the start screen or **Settings → GitHub**, and allow Gui in the browser. Cancel and denial leave local projects available.
3. Gui shows the GitHub name and handle. Product updates are in **Settings → Account**.
4. **Choose repositories on GitHub** installs Gui on selected repositories. Refresh after installation or organization approval.
5. Create a private project under the personal GitHub account with a README, or clone an existing connected repository. Creation persists if cloning is canceled or fails.
6. Use the existing shipping sheet to review files, branch, title, and description. Gui commits, pushes, and opens a PR using the GitHub connection. Existing git identity wins; missing identity uses GitHub noreply without changing global git settings.
7. Disconnect removes the GitHub tokens from the account, and Gui stays signed in. **Settings → Account → Sign out** ends the device's session. Account deletion is available through the authenticated service endpoint.

## Ownership

The `accounts/` Cloudflare Worker owns sign-in (providers, email, and the legacy device flow), identities, sessions, token refresh, contact preferences, repository creation, and pull-request creation. D1 stores encrypted provider tokens and pending device codes; it stores hashes of Gui session and attempt tokens. Server secrets remain in Cloudflare.

The Electron main process stores the device session using secure storage, checks canonical repository names, and supplies git credentials using a temporary askpass script. The renderer receives display state and project actions. Untrusted project previews cannot invoke account IPC. Clone failure only removes the directory reserved by that clone, and never an existing directory or remote repository.

Repository access is the intersection of the user's access and the installed app's access. Credentials and PR creation recheck the connected repository ID. Pushes target the verified GitHub HTTPS endpoint, and branch protection still applies. GitHub App permissions are Contents, Pull requests, and Administration write, plus Metadata and account Email read. Administration is broader than creation, but Gui exposes no deletion or collaborator-management endpoint.

The GitHub name, handle, and verified primary email refresh when GitHub is connected or used to sign in. Product updates default to off, and survive repeat sign-in. Email campaigns require a separate provider and authorization. Authorized Cloudflare operators can query opted-in contact fields; there is no public export endpoint.

## Activation and evidence

See [service setup](../accounts/README.md) for secrets, deployment, desktop build configuration, and checks. Automated tests use GitHub, keychain, and git stand-ins where indicated. They do not establish live private clone, token refresh, or production behavior. Organization creation, merging, and email delivery are outside this implementation.
