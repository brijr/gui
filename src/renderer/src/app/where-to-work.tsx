import { useEffect, useId, useRef, useState } from 'react'
import type { WhereToWorkAnswer, WhereToWorkPrompt } from '../../../shared/types'
import { gui } from '../lib/api'
import { Field, InlineError, Input } from '../lib/field'
import { ChevronDown, ChevronRight } from '../lib/icons'
import { List, ListRow } from '../lib/surface'
import { Button, TextButton } from '../lib/ui'

const CHEVRON = <ChevronRight className="size-3 shrink-0 text-subtle" aria-hidden="true" />

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/**
 * "Where do you want to work?": opening a project on a shared branch like main asks this on
 * the start screen, before anything opens. On main as it is, on a new branch Gui names from
 * the first message, or in a new worktree beside main. Main does what's picked
 * (tab.ts `answerWhereToWork`), asking to trust the project first for the last two.
 */
export function WhereToWork({ prompt }: { prompt: WhereToWorkPrompt }) {
  const [worktree, setWorktree] = useState(false)
  const [name, setName] = useState('')
  // An answer on its way: a trust prompt may be up meanwhile.
  const [pending, setPending] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const busy = pending || prompt.creating
  const { name: project, branch } = prompt

  const answer = async (choice: WhereToWorkAnswer) => {
    if (busy) return false
    setPending(true)
    try {
      return await gui.answerWhereToWork(choice)
    } finally {
      setPending(false)
    }
  }

  const openWorktree = async () => {
    if (worktree) {
      setWorktree(false)
      return
    }
    if (await answer({ kind: 'prepare-worktree' })) setWorktree(true)
  }

  useEffect(() => {
    if (worktree) input.current?.focus()
  }, [worktree])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || busy) return
      if (worktree) setWorktree(false)
      else void gui.answerWhereToWork({ kind: 'cancel' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, worktree])

  return (
    <section aria-labelledby={`${id}-title`} className="flex w-full max-w-md flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 id={`${id}-title`} className="text-title font-semibold">
          Where do you want to work?
        </h1>
        <p className="text-pretty text-muted">
          {project} is on <span className="font-mono">{branch}</span>.
        </p>
      </div>
      <List>
        <li>
          <ListRow
            flush
            disabled={busy}
            title={`On ${branch}`}
            detail={`Edit ${branch} directly.`}
            trailing={CHEVRON}
            onClick={() => void answer({ kind: 'main', always: false })}
          />
        </li>
        <li>
          <ListRow
            flush
            disabled={busy}
            title="On a new branch"
            detail={`${branch} stays as it is. Gui names the branch from your first message.`}
            trailing={CHEVRON}
            onClick={() => void answer({ kind: 'branch' })}
          />
        </li>
        <li>
          <ListRow
            flush
            disabled={busy}
            aria-expanded={worktree}
            aria-controls={`${id}-worktree`}
            title="In a new worktree"
            detail={`A separate copy of your project on its own branch, with its own preview. Keep ${branch} open beside it.`}
            trailing={
              worktree ? (
                <ChevronDown className="size-3 shrink-0 text-subtle" aria-hidden="true" />
              ) : (
                CHEVRON
              )
            }
            onClick={() => void openWorktree()}
          />
          {worktree && (
            <form
              id={`${id}-worktree`}
              className="flex flex-col gap-3 px-3 pt-1 pb-3"
              onSubmit={(event) => {
                event.preventDefault()
                void answer({ kind: 'worktree', name })
              }}
            >
              <Field
                label="What are you working on? (optional)"
                htmlFor={`${id}-name`}
                hint="Names the worktree and its branch. Left blank, it's named for today."
              >
                <Input
                  ref={input}
                  id={`${id}-name`}
                  aria-describedby={`${id}-name-hint`}
                  value={name}
                  maxLength={200}
                  placeholder="Pricing page"
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              {(prompt.uncommitted ?? 0) > 0 && (
                <p className="text-pretty text-small text-muted">
                  Your {plural(prompt.uncommitted ?? 0, 'uncommitted change')}{' '}
                  {prompt.uncommitted === 1 ? 'stays' : 'stay'} on {branch}. The worktree starts
                  from the last commit.
                </p>
              )}
              {prompt.error && (
                <InlineError className="whitespace-pre-wrap">{prompt.error}</InlineError>
              )}
              <div>
                <Button type="submit" variant="primary" loading={prompt.creating} disabled={busy}>
                  {prompt.creating ? 'Creating worktree…' : 'Create worktree'}
                </Button>
              </div>
            </form>
          )}
        </li>
      </List>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          disabled={prompt.creating}
          onClick={() => void gui.answerWhereToWork({ kind: 'cancel' })}
        >
          Cancel
        </Button>
        <TextButton
          tone="muted"
          disabled={busy}
          onClick={() => void answer({ kind: 'main', always: true })}
        >
          Always open {project} on {branch}
        </TextButton>
      </div>
    </section>
  )
}
