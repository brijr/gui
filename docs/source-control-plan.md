# Source control redesign plan

Status: implemented in the repository. The interactive concept remains a design reference; the application now uses the persistent workspace described below. Commit drafts and file selections stay editable during agent runs, while repository mutations wait for the agent to finish. Incoming agent proposals preserve an edited draft until the user explicitly accepts them.

Verification: production build and `bun run check` pass. Fourteen focused Electron checks pass and cover the source control workspace, legacy shipping, agent proposals, Versions publishing, and permission shortcuts using disposable local repositories. State regressions cover refresh selection, project changes, and late operation results; the connected GitHub credential checks cover pushes pinned to the approved commit. Visual inspection covers light/dark floating panels, branch dialogs, and a 320px sidebar. No live hosted pull request was created during verification.

## Direction

Make Source control a persistent workspace for the repository. The default sequence is **choose a branch → select files → commit → push**. Creating a pull request is a separate action. Keep Gui's existing compact panel, shared controls, typography, and GitHub/GitLab support.

The previous implementation centered on a combined shipping request: the branch is a text field behind a disclosure, changing it takes effect during submission, and `shipInfo()` blocks the entire screen when there are no changes or outgoing commits. File selection already commits exactly the selected working-tree paths, preserving excluded staged files. Retain that behavior.

## Screen and interaction

1. **Branch and repository context at the top.** Always show the actual checked-out branch, a searchable branch picker, and a visible **New branch** action. List local branches first and cached remote branches separately, with Current and Default labels. Show the tracking destination and outgoing commit count. A compact branch/status entry above the chat opens this panel, including when the repository is clean; keep the existing More-menu entry.
2. **Branch changes are independent actions.** Selecting an existing branch switches immediately, then refreshes repository status. A remote-only branch creates a local tracking branch explicitly. New branch opens a small dialog with Name and Start from, defaulting to the current branch/HEAD; **Create and switch** does just that. Validate names, duplicates, and branches checked out in another worktree. Dirty files come along only when Git can preserve them; otherwise explain the conflict and keep the current branch and files intact. Never automatically stash or discard edits.
3. **Changed files are the main content.** Show path, readable change status, and a checkbox; put **Select all / Clear** and “2 of 4 selected” above the list. Keep the existing whole-file semantics: a selected path commits its current contents, including unstaged edits. Initially select all eligible files, or the agent's valid explicit selection. Then store an explicit set: newly appearing files remain unchecked on refresh. Preserve the set across remounts and same-branch refreshes; after an explicit branch switch, clear it and refresh. Never silently broaden an empty or stale agent selection to all files.
4. **Compact commit composer.** Put Commit message below the files, with Description behind an optional disclosure. **Commit 2 files** is the primary action and commits locally to the displayed branch. Do not create or switch branches as a side effect of committing. Disable with a visible reason when no files are selected or the message is empty. Keep the existing optional message suggestions, but label them as editable suggestions.
5. **Separate remote actions.** Show “2 commits ready to push to origin/feature-name” and a **Push** action. Push sends existing commits only and never includes uncommitted files, regardless of checkbox selection. After a push, offer **Create pull request**, or **Open pull request** when one exists. Pushing the branch updates its existing PR automatically; opening the PR does not make an additional commit. Push works with any supported Git remote; the PR action depends on host support. No remote leaves commit available with “No remote configured” beside the disabled push action.
6. **Stay in the workspace.** After committing, refresh the remaining files and outgoing count, clear the successful commit's message and selection, and show a short success notice. The user can select another group and make the next commit without closing and reopening a success screen. Keep the panel readable while the agent works; disable mutations with “Wait for the agent to finish.” Refresh on focus, completed turns, explicit refresh, and successful operations without replacing the user's message.

## Main-branch push warning

Show a quiet banner on `main`, `master`, or the detected default branch: “You're on the shared branch. Create a branch to keep changes separate.” A local commit is still available; choosing a branch is explicit rather than a hidden suggestion.

When a push's **actual destination** is `main`, `master`, or the detected default branch, require a warning before the external write:

> Push 2 commits directly to origin/main?
>
> This updates the shared branch immediately and skips pull request review.

Actions: **Cancel**, **Create a branch** (recommended), and **Push to main** (explicit warning-styled action). Substitute the real destination name. Enter/Escape must never implicitly choose the direct push. Do not offer a permanent “don't warn again” option.

Enforce this in the main process, using a main-owned confirmation associated with the initiating window, not a renderer-supplied bypass boolean. Re-read the branch, HEAD, remote, and destination after confirmation; if any changed, refresh and reconfirm. Every app-owned push path, including legacy Share requests, retries, and connected GitHub pushes, goes through this gate. Preserve remote rejection/protection errors; confirmation does not bypass them.

**Create a branch** opens the branch dialog from the current HEAD. If commits already exist on local main, the new branch contains them and can be pushed for review. Creating it does not silently reset or rewrite local main. Explain that when outgoing commits exist. After creating it, return to Source control; the user explicitly clicks Push.

## Implementation sequence

### 1. Repository state and explicit operations

- Extend the existing repository inspection in `src/main/git.ts` to return local/remote branch details, worktree occupancy, default branch, remote name, upstream/destination, outgoing count, HEAD, and operation availability. Preserve existing safe reads, path handling, hooks, identity, and credential behavior.
- Replace whole-screen “blocked” state for clean/busy/conflicted repositories with per-action availability. Only missing project/repository/tools prevents normal repository inspection. A clean repository still supports branch selection and creation.
- Extract focused source-control operations from `src/main/ship.ts`: status, switch branch, create branch, commit selected files, push commits, and create/update a PR. Reuse existing secret scanning, selected-path commits, push/authentication helpers, and PR creation; do not duplicate them or rewrite unrelated proposal/merge workflows.
- Carry an expected branch/HEAD with mutations; validate fresh repository state and selected paths before changing anything. Serialize app-owned Git mutations per repository, including across windows, and retain Git's external lock errors. Honor existing project trust and agent-busy restrictions.
- Add typed contracts in `src/shared/types.ts` and `src/shared/ipc.ts`, bindings in `src/preload/index.ts`, and focused delegation from `src/main/tab.ts`. Repository status must not require an active chat; chat context supplies suggestions only.

### 2. Panel and draft state

- Refactor `src/renderer/src/chat/ship-sheet.tsx` and `shipping-state.ts` around independent operation states and an explicit file selection. Extract BranchPicker, CreateBranchDialog, ChangedFiles, and CommitComposer as the feature requires, using existing surface/dialog/field/button primitives.
- Preserve draft state through dock/float/minimize. Refresh selected paths without adding new ones. Prevent slow results from a previous branch or project from replacing current state.
- Refresh the existing proposal/status bar after branch switches, commits, pushes, and PR operations. Keep its review/merge behavior intact.
- Translate existing `source_control_propose`, Versions publishing, and legacy `share` callers into reviewable drafts for the new workspace. An agent-requested branch creation/switch remains an explicit visible action before Commit. Update the tool descriptions and prompt copy so separate commit/push actions are accurately described.

### 3. Warning and regression verification

- Implement the shared main-process destination warning and cover all push entry points. Cancelling Push writes nothing; retrying Push never makes another commit or changes the file selection.
- Adapt `e2e/ship.spec.ts`, `e2e/agent-source-control.spec.ts`, `e2e/versions.spec.ts`, and affected shortcut checks. Use disposable local working/bare repositories for commits and pushes; no live main-branch push is needed for verification.
- Run affected type/lint/architecture checks, meaningful Git operation tests, and focused Electron tests. Inspect narrow docked and floating panels, keyboard focus, long branch/path names, large file lists, and both appearances using the refactor-ui/verify-design workflow during implementation.

## Acceptance checks

- A clean repository can switch branches and create a branch without a commit.
- Branch picker handles local, remote-only, long names, dirty-switch refusal, and another-worktree occupancy. Initial empty repositories and detached HEAD have clear supported actions; detached commits require creating or selecting a branch.
- A commit contains exactly the checked files, including additions, deletions, and both paths of a rename. Excluded files remain unchanged/staged as before; existing secret-file exclusions and content scanning still apply to committed content. A problematic unselected file does not hide branch management or prevent committing a safe selection.
- New files discovered on refresh stay unchecked; stale or empty explicit agent selections require review rather than falling back to all files.
- Two separate file groups can become two commits without leaving the panel.
- Push with dirty files sends only saved commits. Failed push is retryable without a duplicate commit. No remote still supports local commits.
- Push to main, master, or a custom default branch warns for the actual destination; cancellation, affirmative push, create-branch alternative, and stale-context reconfirmation are covered for every app-owned push path.
- Agent activity/conflicts restrict relevant writes while branch/file context stays visible. Simultaneous Git actions cannot interleave app-owned mutations.

## Scope boundary

This pass covers branch selection/creation, exact file selection, repeatable local commits, independent push and PR actions, and destination warnings. Hunk staging, amend/rebase, branch deletion, force push, automatic stashing, a commit-history browser, and a new diff viewer are follow-up features. They are unnecessary to make the requested flow work well.
