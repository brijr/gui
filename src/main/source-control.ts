import { resolve } from 'node:path'
import type { SourceControlRequest, SourceControlResult } from '../shared/source-control'
import {
  applyConnectedIdentity,
  CommandError,
  commitError,
  git,
  gitAsUser,
  outgoingCount,
  pushDestination,
  type Repo,
  readContext,
  readWorkspace,
  tail,
  withGitMutation,
} from './git'
import {
  assertBranchName,
  commitChanges,
  connectedFor,
  openPullRequest,
  PushCancelled,
  pushSavedCommits,
  type ShipActions,
  selectChanges,
  unstage,
} from './ship'
import { findLeak, leakMessage, localEnvValues, secretIn } from './ship-secrets'

function assertContext(
  repo: Pick<Repo, 'top' | 'branch' | 'head' | 'problem'>,
  request: SourceControlRequest,
) {
  const expected = request.expected
  if (
    resolve(expected.root) !== resolve(repo.top) ||
    expected.branch !== repo.branch ||
    expected.head !== repo.head
  )
    throw new Error('The repository changed. Refresh Source control before continuing.')
  if (repo.problem) throw new Error(repo.problem)
}

async function checkFields(repo: Repo, title: string, body: string, branch: string) {
  const env = await localEnvValues(repo)
  for (const [label, text] of [
    ['The commit message', title],
    ['The description', body],
    ['The branch name', branch],
  ]) {
    const kind = secretIn(text ?? '', env)
    if (kind) throw new Error(leakMessage(label ?? 'The message', kind))
  }
  return env
}

/** Explicit repository actions: committing cannot switch branches, pushing cannot commit. */
export async function sourceControl(
  root: string,
  request: SourceControlRequest,
  actions: ShipActions,
): Promise<SourceControlResult> {
  return withGitMutation(root, async (repo) => {
    assertContext(repo, request)
    actions.assertAvailable()
    const branch = repo.branch
    if (request.kind === 'switch' || request.kind === 'create') {
      await assertBranchName(repo, request.branch)
      await checkFields(repo, '', '', request.branch)
      const workspace = await readWorkspace(repo)
      try {
        if (request.kind === 'switch') {
          const target = workspace.branches.find(
            (item) => item.name === request.branch && item.remote === request.remote,
          )
          if (!target)
            throw new Error('That branch is no longer available. Refresh the branch list.')
          if (target.checkedOutElsewhere)
            throw new Error('That branch is checked out in another worktree.')
          if (request.branch === branch && request.remote === null)
            return { outcome: 'switched', branch }
          const local = repo.refs.has(`refs/heads/${request.branch}`)
          if (request.remote && local)
            throw new Error(
              'A local branch already has this name. Select the local branch instead.',
            )
          actions.assertAvailable()
          assertContext(await readContext(root), request)
          await gitAsUser(
            repo,
            request.remote
              ? [
                  'switch',
                  '--quiet',
                  `--create=${request.branch}`,
                  '--track',
                  '--',
                  `refs/remotes/${request.remote}/${request.branch}`,
                ]
              : ['switch', '--quiet', '--', request.branch],
          )
        } else {
          if (workspace.branches.some((item) => item.name === request.branch))
            throw new Error('That branch already exists. Choose a different name.')
          const base = request.base
          if (
            base !== null &&
            !repo.refs.has(base) &&
            !(base === `refs/heads/${branch}` && !repo.hasHead)
          )
            throw new Error('The starting branch is no longer available. Refresh and try again.')
          if (base !== null && !base.startsWith('refs/heads/') && !base.startsWith('refs/remotes/'))
            throw new Error('Choose a local or remote branch to start from.')
          actions.assertAvailable()
          assertContext(await readContext(root), request)
          if (!repo.hasHead && (!base || base === `refs/heads/${branch}`))
            await git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${request.branch}`])
          else
            await gitAsUser(repo, [
              'switch',
              '--quiet',
              `--create=${request.branch}`,
              '--',
              base ?? 'HEAD',
            ])
        }
      } catch (error) {
        if (!(error instanceof CommandError)) throw error
        if (/overwritten|would be lost/i.test(error.output))
          throw new Error(
            'Git cannot switch branches without overwriting your edits. Commit them or choose a new branch from the current one.',
          )
        throw new Error(`Couldn’t switch branches:\n${tail(error.output, 4)}`)
      }
      return {
        outcome: request.kind === 'create' ? 'created-branch' : 'switched',
        branch: request.branch,
      }
    }
    if (!branch) throw new Error('Create or select a branch first. HEAD is detached.')
    if (request.kind === 'commit') {
      const title = request.title.replace(/\s+/g, ' ').trim()
      const body = request.body.trim()
      if (!title) throw new Error('Add a commit message first.')
      const changes = selectChanges(repo.changes, request.files)
      const env = await checkFields(repo, title, body, branch)
      const leak = await findLeak(repo, changes, env)
      if (leak) throw new Error(leak)
      const connected = await connectedFor(repo)
      if (connected) await applyConnectedIdentity(repo, connected.profile)
      actions.assertAvailable()
      assertContext(await readContext(root), request)
      await unstage(repo, repo.stagedSecrets)
      try {
        await commitChanges(repo, changes, title, body)
      } catch (error) {
        throw new Error(await commitError(repo, error))
      }
      return {
        outcome: 'committed',
        branch,
        commit: (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim(),
      }
    }
    const destination = await pushDestination(repo, branch)
    if (!destination) throw new Error('This project has no remote configured.')
    const ahead = await outgoingCount(repo, destination)
    if (request.kind === 'push') {
      if (!ahead) throw new Error('There are no saved commits to push.')
      try {
        await pushSavedCommits(repo, branch, destination.branch, actions)
      } catch (error) {
        if (error instanceof PushCancelled)
          return { outcome: error.choice === 'branch' ? 'branch-required' : 'cancelled', branch }
        throw error
      }
      return { outcome: 'pushed', branch }
    }
    if (ahead) throw new Error('Push your saved commits before creating a pull request.')
    if (!repo.refs.has(`refs/remotes/${destination.remote}/${destination.branch}`))
      throw new Error('Push this branch before creating a pull request.')
    if (destination.branch === repo.defaultBranch)
      throw new Error('Create a separate branch for a pull request.')
    if (repo.remote?.host === 'other')
      throw new Error('This remote does not support a pull request link.')
    const title = request.title.trim() || (await git(repo, ['log', '-1', '--format=%s'])).trim()
    await checkFields(repo, title, request.body, branch)
    actions.assertAvailable()
    return openPullRequest(repo, destination.branch, repo.defaultBranch, title, request.body.trim())
  })
}
