# GitHub projects and accounts

Gui requires a Gui account, made on WorkOS AuthKit with Google, Apple, GitHub, or email (see [the account service](../accounts/README.md)). GitHub is also a connection on that account, used only to pick a repository to clone. Local projects need an account but not GitHub. The GitHub App and D1 database are created. Worker code, database binding, rate limiter, public GitHub identifiers, and encrypted server secrets are deployed at `https://accounts.usegui.com` (and `https://gui-accounts.brijr.workers.dev` for earlier builds). Gui defaults to `accounts.usegui.com`. Live device authorization, attempt storage, cancellation, sign-in from the installed Gui app, and connected repository listing have been verified. Live private cloning remains unverified.

## Journey

1. Sign in to Gui from the start screen.
2. For GitHub projects, choose **Connect GitHub** in the start screen's **Clone…** form or in **Settings → GitHub**, and allow Gui in the browser. Cancel and denial leave local projects available.
3. Gui shows the GitHub name and handle. Product updates are in **Settings → Account**.
4. **Choose on GitHub** installs Gui on selected repositories. The **Clone…** list reads them again when Gui comes back into focus.
5. Clone a connected repository from **Clone…** on the start screen, or any repository by its address there with the user's own git credentials.
6. After that, Gui leaves Git alone: it never commits, pushes, branches, fetches or opens pull requests. The agent does that through its own shell when asked, and the user can use the terminal drawer. The toolbar shows the current branch, read only.
7. Disconnect removes the GitHub tokens from the account, and Gui stays signed in. **Settings → Account → Sign out** ends the device's session. Account deletion is available through the authenticated service endpoint.

## Ownership

The `accounts/` Cloudflare Worker owns sign-in (WorkOS AuthKit, and the legacy device flow), identities, sessions, token refresh, contact preferences, and repository credentials for cloning. Its repository-creation and pull-request routes are no longer used by the app. D1 stores encrypted provider tokens and pending device codes; it stores hashes of Gui session and attempt tokens. Server secrets remain in Cloudflare.

The Electron main process stores the device session using secure storage, checks canonical repository names, and supplies git credentials using a temporary askpass script. The renderer receives display state and project actions. Untrusted project previews cannot invoke account IPC. Clone failure only removes the directory reserved by that clone, and never an existing directory or remote repository. Each clone asks the service for a fresh credential.

Repository access is the intersection of the user's access and the installed app's access. Credentials recheck the connected repository ID. The GitHub App still asks for Contents, Pull requests, and Administration write, plus Metadata and account Email read; with only cloning left, Contents read would do, and narrowing the app is separate cleanup.

The GitHub name, handle, and verified primary email refresh when GitHub is connected or used to sign in. New accounts with an email start subscribed to product updates, as the terms and privacy page say; people turn them off in **Settings → Account**, and the choice survives repeat sign-in. Email campaigns require a separate provider and authorization. Authorized Cloudflare operators can query opted-in contact fields; there is no public export endpoint.

## Activation and evidence

See [service setup](../accounts/README.md) for secrets, deployment, desktop build configuration, and checks. Automated tests use GitHub, keychain, and git stand-ins where indicated. They do not establish live private clone, token refresh, or production behavior. Organization creation, merging, and email delivery are outside this implementation.
