import { useEffect, useId, useState } from 'react'
import type { WhereToWorkAnswer, WhereToWorkPrompt } from '../../../shared/types'
import { gui } from '../lib/api'
import { ChevronRight } from '../lib/icons'
import { List, ListRow } from '../lib/surface'
import { Button, TextButton } from '../lib/ui'

const CHEVRON = <ChevronRight className="size-3 shrink-0 text-subtle" aria-hidden="true" />

/**
 * "Where do you want to work?": opening a project on a shared branch like main asks this on
 * the start screen, before anything opens. On main as it is, or on a new branch Gui names
 * from the first message. Main does what's picked (tab.ts `answerWhereToWork`), asking to
 * trust the project first for a new branch.
 */
export function WhereToWork({ prompt }: { prompt: WhereToWorkPrompt }) {
  // An answer on its way: a trust prompt may be up meanwhile.
  const [pending, setPending] = useState(false)
  const id = useId()
  const { name: project, branch } = prompt

  const answer = async (choice: WhereToWorkAnswer) => {
    if (pending) return false
    setPending(true)
    try {
      return await gui.answerWhereToWork(choice)
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || pending) return
      void gui.answerWhereToWork({ kind: 'cancel' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

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
            disabled={pending}
            title={`On ${branch}`}
            detail={`Edit ${branch} directly.`}
            trailing={CHEVRON}
            onClick={() => void answer({ kind: 'main', always: false })}
          />
        </li>
        <li>
          <ListRow
            flush
            disabled={pending}
            title="On a new branch"
            detail={`${branch} stays as it is. Gui names the branch from your first message.`}
            trailing={CHEVRON}
            onClick={() => void answer({ kind: 'branch' })}
          />
        </li>
      </List>
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => void gui.answerWhereToWork({ kind: 'cancel' })}>
          Cancel
        </Button>
        <TextButton
          tone="muted"
          disabled={pending}
          onClick={() => void answer({ kind: 'main', always: true })}
        >
          Always open {project} on {branch}
        </TextButton>
      </div>
    </section>
  )
}
