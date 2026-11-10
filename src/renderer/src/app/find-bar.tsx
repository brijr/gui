import { useEffect, useRef, useState } from 'react'
import {
  applyFindAction,
  CLOSED_FIND,
  type FindResult,
  findStatus,
  MAX_FIND_TEXT,
} from '../../../shared/find'
import { matchesShortcut } from '../../../shared/shortcuts'
import type { WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Input } from '../lib/field'
import { ChevronDown, ChevronUp, Search, X } from '../lib/icons'
import { Banner } from '../lib/surface'
import { IconButton, TIGHT_HIT_AREA } from '../lib/ui'

/** Find's command for a terminal, dispatched on its `data-find-scope` (`FindAction` detail). */
export const FIND_EVENT = 'gui:find'

interface FindBarProps {
  /** What it searches, for assistive tech: "Find in page" */
  label: string
  query: string
  /** What it found (`findStatus`) */
  status: string
  /** There are matches to step through */
  found: boolean
  /** Bumped to put the keyboard in the field, its text selected (⌘F again) */
  focusKey: number
  onQuery: (query: string) => void
  onStep: (step: 1 | -1) => void
  onClose: () => void
}

/**
 * Edit → Find's field, its count, the previous and next match, and Done: ↩ is the next match,
 * ⇧↩ the previous one, Esc closes it. Laid out by its place: the preview's bar or a terminal's.
 */
function FindControls({
  label,
  query,
  status,
  found,
  focusKey,
  onQuery,
  onStep,
  onClose,
}: FindBarProps) {
  const field = useRef<HTMLInputElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ⌘F focuses it again.
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [focusKey])
  return (
    <>
      <Input
        ref={field}
        aria-label={label}
        placeholder="Find"
        className="w-56"
        value={query}
        maxLength={MAX_FIND_TEXT}
        spellCheck={false}
        leading={<Search className="mx-2 size-3.5 shrink-0 text-subtle" aria-hidden="true" />}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onStep(event.shiftKey ? -1 : 1)
          } else if (matchesShortcut(event, 'closeFind')) {
            // Not focus mode's Esc, nor the terminal's.
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
      />
      <span role="status" className="shrink-0 text-small text-subtle tabular-nums">
        {status}
      </span>
      <span className="flex-1" />
      <IconButton
        className={TIGHT_HIT_AREA}
        label="Previous match"
        shortcut="findPrevious"
        icon={ChevronUp}
        size="sm"
        disabled={!found}
        onClick={() => onStep(-1)}
      />
      <IconButton
        className={TIGHT_HIT_AREA}
        label="Next match"
        shortcut="findNext"
        icon={ChevronDown}
        size="sm"
        disabled={!found}
        onClick={() => onStep(1)}
      />
      <IconButton
        className={TIGHT_HIT_AREA}
        label="Done"
        shortcut="closeFind"
        icon={X}
        size="sm"
        onClick={onClose}
      />
    </>
  )
}

/** The preview's find bar: a slim bar under the toolbar, as in Safari. */
export function FindBar(props: FindBarProps) {
  return (
    // The search landmark; the bar's soft tint over the window's surface, as the other bars.
    <search className="relative z-chrome shrink-0 bg-surface">
      <Banner wrap={false} className="gap-1 pl-2">
        <FindControls {...props} />
      </Banner>
    </search>
  )
}

/** A terminal's find bar: floating at the top of the drawer, so the terminal keeps its size. */
export function FloatingFindBar({ className, ...props }: FindBarProps & { className?: string }) {
  return (
    <search
      className={cn(
        'flex items-center gap-1 rounded-lg border border-line bg-overlay p-1 text-small shadow-popover',
        className,
      )}
    >
      <FindControls {...props} />
    </search>
  )
}

/**
 * Edit → Find in the preview (main/tab.ts finds with Chromium). Keyed by tab with the rest of
 * the bars, so each tab starts without one; main ends a tab's search as it's switched away.
 */
export function PreviewFind({ state }: { state: WindowState }) {
  const [find, setFind] = useState(CLOSED_FIND)
  const [result, setResult] = useState<FindResult | null>(null)
  // As it is now, for a command that comes before the next render.
  const current = useRef(find)
  const update = (next: typeof find) => {
    current.current = next
    setFind(next)
  }

  useEffect(() => gui.onFindResult(setResult), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `update` only sets state.
  useEffect(
    () =>
      gui.onFind(({ action, area }) => {
        if (area !== 'preview') return
        const was = current.current
        const { state: next, step } = applyFindAction(was, action)
        update(next)
        if (step) gui.findInPage(next.query, step === 1, false)
        // Reopened with its text: its matches show again.
        else if (!was.open && next.query) gui.findInPage(next.query, true, true)
      }),
    [],
  )
  const visible = state.preview.visible
  // The page went away (the app stopped, a canvas's frame closed): so does the bar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `update` only sets state.
  useEffect(() => {
    if (!visible && current.current.open) update({ ...current.current, open: false })
  }, [visible])

  if (!find.open) return null
  return (
    <FindBar
      label="Find in page"
      query={find.query}
      status={findStatus(find.query, result)}
      found={(result?.total ?? 0) > 0 && find.query !== ''}
      focusKey={find.focusKey}
      onQuery={(text) => {
        update({ ...current.current, query: text })
        setResult(null)
        if (text) gui.findInPage(text, true, true)
        else gui.stopFindInPage()
      }}
      onStep={(step) => {
        const { query } = current.current
        if (query) gui.findInPage(query, step === 1, false)
      }}
      onClose={() => {
        update({ ...current.current, open: false })
        setResult(null)
        gui.stopFindInPage()
        gui.focusPreview()
      }}
    />
  )
}
