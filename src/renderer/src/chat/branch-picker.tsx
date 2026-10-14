import { useEffect, useId, useRef, useState } from 'react'
import type { SourceControlWorkspace } from '../../../shared/source-control'
import { Dialog } from '../lib/dialog'
import { Field, Input, Select } from '../lib/field'
import { Check, ChevronDown, GitBranch, Plus } from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Button } from '../lib/ui'
import { performSourceControl, setCreateBranchOpen, useShipSheet } from './shipping-state'

export function BranchPicker({
  workspace,
  disabled,
}: {
  workspace: SourceControlWorkspace
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  const shown = workspace.branches.filter((branch) =>
    `${branch.remote ?? ''}/${branch.name}`.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <>
      <Button
        icon={GitBranch}
        trailingIcon={ChevronDown}
        className="min-w-0 flex-1 justify-start"
        aria-label={`Select branch, current branch ${workspace.branch ?? 'detached HEAD'}`}
        title={workspace.branch ?? 'Detached HEAD'}
        disabled={disabled}
        onClick={() => {
          setSearch('')
          setOpen(true)
        }}
      >
        <PathText
          path={workspace.branch ?? 'Detached HEAD'}
          className="min-w-0 flex-1 text-left font-mono"
        />
      </Button>
      <Button icon={Plus} disabled={disabled} onClick={() => setCreateBranchOpen(true)}>
        New branch
      </Button>
      <Dialog
        title="Switch branch"
        open={open}
        onClose={() => setOpen(false)}
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
          {(['Local branches', 'Remote branches'] as const).map((label, group) => {
            const branches = shown.filter((branch) => (branch.remote !== null) === (group === 1))
            if (!branches.length) return null
            return (
              <div key={label} className="flex flex-col gap-0.5">
                <p className="px-2 py-1 text-caption text-subtle">{label}</p>
                {branches.map((branch) => {
                  const current = branch.remote === null && branch.name === workspace.branch
                  const localExists =
                    branch.remote !== null &&
                    workspace.branches.some(
                      (item) => item.remote === null && item.name === branch.name,
                    )
                  return (
                    <Button
                      key={`${branch.remote ?? 'local'}/${branch.name}`}
                      variant="ghost"
                      className="h-auto min-h-7 justify-start text-left"
                      disabled={disabled || branch.checkedOutElsewhere || localExists}
                      title={
                        branch.checkedOutElsewhere
                          ? 'Checked out in another worktree'
                          : localExists
                            ? 'Select the local branch above'
                            : undefined
                      }
                      onClick={() => {
                        setOpen(false)
                        void performSourceControl({
                          kind: 'switch',
                          branch: branch.name,
                          remote: branch.remote,
                        })
                      }}
                    >
                      <PathText
                        className="min-w-0 flex-1 font-mono"
                        path={branch.remote ? `${branch.remote}/${branch.name}` : branch.name}
                      />
                      <span className="shrink-0 text-caption text-subtle">
                        {branch.checkedOutElsewhere
                          ? 'In use'
                          : current
                            ? 'Current'
                            : branch.name === workspace.defaultBranch
                              ? 'Default'
                              : ''}
                      </span>
                      {current && <Check className="size-3 shrink-0" aria-hidden="true" />}
                    </Button>
                  )
                })}
              </div>
            )
          })}
          {shown.length === 0 && <p className="p-2 text-small text-muted">No matching branches.</p>}
        </div>
      </Dialog>
    </>
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
