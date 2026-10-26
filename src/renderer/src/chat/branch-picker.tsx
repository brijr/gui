import { memo, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { GitBranchInfo, SourceControlWorkspace } from '../../../shared/source-control'
import { gui } from '../lib/api'
import { Dialog } from '../lib/dialog'
import { readableError } from '../lib/errors'
import { Field, Input, Select } from '../lib/field'
import { Check, ChevronDown, GitBranch, Plus, SquareStack } from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Button } from '../lib/ui'
import {
  performSourceControl,
  setCreateBranchOpen,
  setPickerOpen,
  setWorktreeOpen,
  useShipSheet,
} from './shipping-state'

export function BranchPicker({
  workspace,
  disabled,
}: {
  workspace: SourceControlWorkspace
  disabled: boolean
}) {
  const open = useShipSheet((state) => state.pickerOpen)
  const [search, setSearch] = useState('')
  // Typing stays quick in a long list: the rows follow a step behind.
  const query = useDeferredValue(search).toLowerCase()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) {
      setSearch('')
      input.current?.focus()
    }
  }, [open])
  const groups = useMemo(() => {
    const shown = workspace.branches.filter((branch) =>
      `${branch.remote ?? ''}/${branch.name}`.toLowerCase().includes(query),
    )
    const local = new Set(
      workspace.branches.filter((item) => item.remote === null).map((item) => item.name),
    )
    return {
      count: shown.length,
      lists: (['Local branches', 'Remote branches'] as const).map((label, group) => ({
        label,
        branches: shown
          .filter((branch) => (branch.remote !== null) === (group === 1))
          .map((branch) => ({
            branch,
            localExists: branch.remote !== null && local.has(branch.name),
          })),
      })),
    }
  }, [workspace.branches, query])
  return (
    <>
      <Button
        icon={GitBranch}
        trailingIcon={ChevronDown}
        // Its own row: the new-branch and new-worktree buttons wrap under it in a narrow chat.
        className="min-w-0 flex-1 basis-full justify-start"
        aria-label={`Select branch, current branch ${workspace.branch ?? 'none'}`}
        title={workspace.branch ?? 'No branch'}
        disabled={disabled}
        onClick={() => setPickerOpen(true)}
      >
        <PathText
          path={workspace.branch ?? 'No branch'}
          className="min-w-0 flex-1 text-left font-mono"
        />
      </Button>
      <Button icon={Plus} disabled={disabled} onClick={() => setCreateBranchOpen(true)}>
        New branch
      </Button>
      <Button icon={SquareStack} disabled={disabled} onClick={() => setWorktreeOpen(true)}>
        New worktree
      </Button>
      <Dialog
        title="Switch branch"
        open={open}
        onClose={() => setPickerOpen(false)}
        className="flex flex-col gap-2 p-3"
      >
        <Input
          ref={input}
          aria-label="Find a branch"
          placeholder="Find a branch…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto scroll-stable">
          {groups.lists.map(({ label, branches }) =>
            branches.length ? (
              <div key={label} className="flex flex-col gap-0.5">
                <p className="px-2 py-1 text-caption text-subtle">{label}</p>
                {branches.map(({ branch, localExists }) => (
                  <BranchRow
                    key={`${branch.remote ?? 'local'}/${branch.name}`}
                    branch={branch}
                    current={branch.remote === null && branch.name === workspace.branch}
                    isDefault={branch.name === workspace.defaultBranch}
                    localExists={localExists}
                    disabled={disabled}
                  />
                ))}
              </div>
            ) : null,
          )}
          {groups.count === 0 && <p className="p-2 text-small text-muted">No matching branches.</p>}
        </div>
      </Dialog>
    </>
  )
}

/**
 * One branch in the picker. Picking it switches to it; one checked out in another worktree
 * can't be switched to here, so picking it opens that worktree instead.
 */
const BranchRow = memo(function BranchRow({
  branch,
  current,
  isDefault,
  localExists,
  disabled,
}: {
  branch: GitBranchInfo
  current: boolean
  isDefault: boolean
  localExists: boolean
  disabled: boolean
}) {
  const elsewhere = branch.checkedOutElsewhere
  const opens = elsewhere && branch.worktree !== null
  return (
    <Button
      variant="ghost"
      className="h-auto min-h-7 justify-start text-left"
      disabled={(disabled && !opens) || (elsewhere && !opens) || localExists}
      title={
        opens
          ? `Checked out in the worktree ${branch.worktree}`
          : elsewhere
            ? 'Checked out in a worktree whose folder is gone'
            : localExists
              ? 'Select the local branch above'
              : undefined
      }
      onClick={() => {
        setPickerOpen(false)
        if (opens && branch.worktree) {
          gui
            .openWorktree(branch.worktree)
            .catch((error: unknown) => useShipSheet.setState({ error: readableError(error) }))
          return
        }
        void performSourceControl({ kind: 'switch', branch: branch.name, remote: branch.remote })
      }}
    >
      <PathText
        className="min-w-0 flex-1 font-mono"
        path={branch.remote ? `${branch.remote}/${branch.name}` : branch.name}
      />
      <span className="shrink-0 text-caption text-subtle">
        {opens ? 'Open' : elsewhere ? 'In use' : current ? 'Current' : isDefault ? 'Default' : ''}
      </span>
      {current && <Check className="size-3 shrink-0" aria-hidden="true" />}
    </Button>
  )
})

/**
 * A new worktree of the project: a separate copy on its own branch, which opens in its own
 * tab with its own preview and chat. Uncommitted changes stay here.
 */
export function CreateWorktreeDialog({
  branch,
  uncommitted,
}: {
  branch: string | null
  uncommitted: number
}) {
  const open = useShipSheet((state) => state.worktreeOpen)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    setName('')
    setError(null)
    input.current?.focus()
  }, [open])
  const close = () => {
    if (!busy) setWorktreeOpen(false)
  }
  const create = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await gui.createWorktree(name)
      setWorktreeOpen(false)
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }
  const here = branch ?? 'this branch'
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New worktree"
      className="flex flex-col gap-3 p-3"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void create()}>
            {busy ? 'Creating worktree…' : 'Create worktree'}
          </Button>
        </>
      }
    >
      <p className="text-pretty text-small text-muted">
        A separate copy of your project on its own branch, so this work stays apart from {here}. It
        opens in a new tab, with its own preview and chat.
      </p>
      <Field
        label="What are you working on? (optional)"
        htmlFor={`${id}-name`}
        hint="Names the worktree and its branch. Left blank, it's named for today."
      >
        <Input
          id={`${id}-name`}
          ref={input}
          aria-describedby={`${id}-name-hint`}
          maxLength={200}
          value={name}
          disabled={busy}
          placeholder="Pricing page"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void create()
            }
          }}
        />
      </Field>
      {uncommitted > 0 && (
        <p className="text-pretty text-caption text-muted">
          Your{' '}
          {uncommitted === 1
            ? '1 uncommitted change stays'
            : `${uncommitted} uncommitted changes stay`}{' '}
          on {here}. The worktree starts from the last commit.
        </p>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-small text-danger">
          {error}
        </p>
      )}
    </Dialog>
  )
}

export function CreateBranchDialog({
  workspace,
  suggested,
}: {
  workspace: SourceControlWorkspace
  suggested: string
}) {
  const open = useShipSheet((state) => state.createOpen)
  const busy = useShipSheet((state) => state.busy)
  const error = useShipSheet((state) => state.error)
  const [name, setName] = useState(suggested)
  const [base, setBase] = useState(workspace.branch ? `refs/heads/${workspace.branch}` : '')
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    setName(suggested)
    setBase(workspace.branch ? `refs/heads/${workspace.branch}` : '')
  }, [open, suggested, workspace.branch])
  useEffect(() => {
    if (open && !busy) input.current?.focus()
  }, [open, busy])
  const close = () => {
    if (!busy) setCreateBranchOpen(false)
  }
  const create = () => {
    if (name.trim() && !busy && !workspace.writeBlocked)
      void performSourceControl({ kind: 'create', branch: name.trim(), base: base || null })
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Create a branch"
      className="flex flex-col gap-3 p-3"
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || busy || Boolean(workspace.writeBlocked)}
            loading={busy}
            onClick={create}
          >
            Create and switch
          </Button>
        </>
      }
    >
      <Field label="Branch name" htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          ref={input}
          mono
          maxLength={200}
          value={name}
          disabled={busy}
          placeholder="feature/my-change"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              create()
            }
          }}
        />
      </Field>
      <Field label="Start from" htmlFor={`${id}-base`}>
        <Select
          id={`${id}-base`}
          value={base}
          disabled={busy}
          onChange={(event) => setBase(event.target.value)}
        >
          {!workspace.branch && <option value="">Current commit</option>}
          {workspace.branches.map((branch) => {
            const ref = branch.remote
              ? `refs/remotes/${branch.remote}/${branch.name}`
              : `refs/heads/${branch.name}`
            return (
              <option key={ref} value={ref}>
                {branch.remote ? `${branch.remote}/${branch.name}` : branch.name}
                {branch.name === workspace.branch && !branch.remote ? ' (current)' : ''}
              </option>
            )
          })}
        </Select>
      </Field>
      <p className="text-caption text-muted">
        Your uncommitted files come along when Git can preserve them.
      </p>
      {workspace.ahead > 0 && (
        <p className="text-caption text-muted">
          Starting from the current branch includes its saved commits. The original branch will not
          be reset.
        </p>
      )}
      {error && (
        <p role="alert" className="whitespace-pre-wrap text-small text-danger">
          {error}
        </p>
      )}
    </Dialog>
  )
}
