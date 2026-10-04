import { Check, ChevronDown, Search } from 'lucide-react'
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { AgentSetting, ModelSettings } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'

type Choice = AgentSetting['options'][number]

/** Lists longer than this get a search field. */
const SEARCH_AFTER = 8
/** Room kept between the picker and the panel's edges. */
const EDGE = 8
/** Between the picker and the button. */
const GAP = 4
const WIDTH = 288
/** In a tall panel the list stops growing here and scrolls. */
const MAX_HEIGHT = 440

/** Where the picker goes, in the chat view's CSS pixels. */
interface Placement {
  left: number
  width: number
  maxHeight: number
  /** From the view's bottom edge when it opens above the button, else null */
  bottom: number | null
  /** From the view's top edge when it opens below the button, else null */
  top: number | null
}

/**
 * Against the button's right edge, above it unless there's more room below. The chat is
 * its own view and can't draw outside it, so the picker stays inside the panel and takes
 * the height there is.
 */
function place(button: HTMLElement): Placement {
  const panel = (button.closest('[data-chat-panel]') ?? document.body).getBoundingClientRect()
  const at = button.getBoundingClientRect()
  const width = Math.min(WIDTH, panel.width - EDGE * 2)
  const left = Math.max(panel.left + EDGE, Math.min(at.right - width, panel.right - EDGE - width))
  const above = at.top - GAP - panel.top - EDGE
  const below = panel.bottom - EDGE - at.bottom - GAP
  return above >= below
    ? {
        left,
        width,
        maxHeight: Math.min(MAX_HEIGHT, above),
        bottom: window.innerHeight - at.top + GAP,
        top: null,
      }
    : { left, width, maxHeight: Math.min(MAX_HEIGHT, below), bottom: null, top: at.bottom + GAP }
}

/** The selected choice's name; null when the agent reports a value it doesn't list. */
function choiceName(setting: AgentSetting) {
  return setting.options.find((option) => option.value === setting.value)?.name ?? null
}

/** "OpenCode Zen/Big Pickle" reads as "Big Pickle"; the picker keeps the full name. */
function shortName(name: string) {
  return name.split('/').at(-1)?.trim() || name
}

/** Under its provider's header, "Anthropic/Claude Sonnet 4" reads as "Claude Sonnet 4". */
function rowName(choice: Choice) {
  const prefix = choice.group && `${choice.group}/`
  if (!prefix || !choice.name.startsWith(prefix)) return choice.name
  return choice.name.slice(prefix.length).trim() || choice.name
}

/** Every typed word appears somewhere in the name, value or group, ignoring case. */
function matches(choice: Choice, words: string[]) {
  const text = `${choice.name} ${choice.value} ${choice.group ?? ''}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * Choices under their group's header, groups in the order they first appear, each row
 * numbered in that order. Without groups there's one section and no header.
 */
function sections(choices: Choice[], grouped: boolean) {
  const byGroup = new Map<string | null, Choice[]>()
  for (const choice of choices) {
    const list = byGroup.get(choice.group)
    if (list) list.push(choice)
    else byGroup.set(choice.group, [choice])
  }
  let index = 0
  return [...byGroup].map(([group, list]) => ({
    group,
    label: grouped ? (group ?? 'Other') : null,
    rows: list.map((choice) => ({ choice, index: index++ })),
  }))
}

/** What the next turn runs on; opens the model picker to change it. */
export function ModelButton({ models }: { models: ModelSettings }) {
  const [placement, setPlacement] = useState<Placement | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const pickerId = useId()
  const fullName = choiceName(models.model) ?? models.model.value
  const model = shortName(fullName)
  const effort = models.effort && (choiceName(models.effort) ?? models.effort.value)

  const close = (refocus: boolean) => {
    setPlacement(null)
    if (refocus) button.current?.focus()
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={placement !== null}
        aria-controls={placement ? pickerId : undefined}
        aria-label={effort ? `Model: ${model}, effort ${effort}` : `Model: ${model}`}
        title={effort ? `${fullName} · ${effort}` : fullName}
        onClick={(event) => setPlacement(placement ? null : place(event.currentTarget))}
        className={cn(
          'no-drag flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-[12px] transition-colors hover:bg-hover hover:text-fg',
          placement ? 'bg-hover text-fg' : 'text-muted',
        )}
      >
        <span className="truncate">{effort ? `${model} · ${effort}` : model}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </button>
      {placement && (
        <ModelPicker
          id={pickerId}
          models={models}
          placement={placement}
          button={button}
          onClose={close}
        />
      )}
    </>
  )
}

interface ModelPickerProps {
  id: string
  models: ModelSettings
  placement: Placement
  button: RefObject<HTMLButtonElement | null>
  /** `refocus` returns focus to the button (Esc, a pick); not after a click elsewhere. */
  onClose: (refocus: boolean) => void
}

/**
 * The agent's models under their provider, searchable when the list is long, and its
 * effort levels when it has them. A model applies on pick and closes the picker; an
 * effort level applies and leaves it open.
 */
function ModelPicker({ id, models, placement, button, onClose }: ModelPickerProps) {
  const { model, effort } = models
  const root = useRef<HTMLDivElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = `${id}-list`
  const effortId = `${id}-effort`
  const searchable = model.options.length > SEARCH_AFTER
  const [query, setQuery] = useState('')
  /** The highlighted model's value; null for the first match. */
  const [active, setActive] = useState<string | null>(model.value)

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const grouped = model.options.some((choice) => choice.group !== null)
  const shown = sections(
    model.options.filter((choice) => matches(choice, words)),
    grouped,
  )
  const rows = shown.flatMap((section) => section.rows)
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.choice.value === active),
  )
  const optionId = (index: number) => `${id}-option-${index}`
  const activeId = rows[activeIndex] ? optionId(activeIndex) : undefined

  useEffect(() => {
    ;(searchField.current ?? list.current)?.focus()
  }, [])

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  // A click elsewhere in the chat, or anywhere outside it (the view loses focus), closes
  // it; so does a resize, which moves the button.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (root.current?.contains(target) || button.current?.contains(target)) return
      onClose(false)
    }
    const dismiss = () => onClose(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [button, onClose])

  const pick = (choice: Choice) => {
    gui.setAgentSetting(model.id, choice.value)
    onClose(true)
  }

  const onSearch = (text: string) => {
    setQuery(text)
    // The first match; with the search cleared, the current model again.
    setActive(text.trim() ? null : model.value)
  }

  /** ↑/↓ and Enter, from the search field or (without one) the list. */
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = rows[Math.min(Math.max(activeIndex + step, 0), rows.length - 1)]
      if (next) setActive(next.choice.value)
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const row = rows[activeIndex]
      if (row) pick(row.choice)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onClose(true)
      return
    }
    // Typing anywhere in the picker goes to the search field.
    const typed = event.key.length === 1 && event.key !== ' '
    const field = searchField.current
    if (field && typed && event.target !== field && !event.metaKey && !event.ctrlKey) {
      field.focus()
    }
  }

  // Focus stays in the search field (or list) when clicking rows and headers.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element && event.target.closest('input, button'))) {
      event.preventDefault()
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (!(next instanceof Node) || event.currentTarget.contains(next)) return
    if (!button.current?.contains(next)) onClose(false)
  }

  const renderRow = ({ choice, index }: (typeof rows)[number]) => {
    const selected = choice.value === model.value
    return (
      // Focus stays on the search field (or list), which handles the keys and points at
      // the highlighted option through aria-activedescendant.
      // biome-ignore lint/a11y/useFocusableInteractive: see above
      // biome-ignore lint/a11y/useKeyWithClickEvents: see above
      <div
        key={choice.value}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        title={choice.name}
        onPointerMove={() => {
          if (index !== activeIndex) setActive(choice.value)
        }}
        onClick={() => pick(choice)}
        className={cn(
          'flex h-7 items-center gap-2 rounded-md px-2 text-[12px]',
          index === activeIndex && 'bg-hover',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{rowName(choice)}</span>
        {selected && <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />}
      </div>
    )
  }

  const above = placement.bottom !== null
  return createPortal(
    <div
      ref={root}
      id={id}
      role="dialog"
      aria-label="Choose a model"
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onBlur={onBlur}
      style={{
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
        top: placement.top ?? undefined,
        bottom: placement.bottom ?? undefined,
      }}
      className={cn(
        'fixed z-50 flex flex-col overflow-hidden rounded-lg border border-line-strong bg-raised text-fg',
        'shadow-[0_8px_24px_rgb(0_0_0/0.14),0_1px_3px_rgb(0_0_0/0.08)] dark:shadow-[0_8px_24px_rgb(0_0_0/0.5),0_1px_3px_rgb(0_0_0/0.3)]',
        'transition-[opacity,translate] duration-150 ease-out starting:opacity-0',
        above ? 'starting:translate-y-1' : 'starting:-translate-y-1',
      )}
    >
      {searchable && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5">
          <Search className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
          <input
            ref={searchField}
            type="text"
            role="combobox"
            aria-label="Search models"
            aria-controls={listId}
            aria-expanded
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            placeholder="Search models…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={onListKeyDown}
            className="h-9 min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none focus-visible:outline-none placeholder:text-subtle"
          />
        </div>
      )}
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Models"
        // With a search field, focus stays there; without one, the list takes it.
        tabIndex={searchable ? -1 : 0}
        aria-activedescendant={searchable ? undefined : activeId}
        onKeyDown={searchable ? undefined : onListKeyDown}
        className={cn(
          'min-h-0 overflow-y-auto overscroll-contain outline-none',
          rows.length > 0 && 'p-1',
        )}
      >
        {shown.map((section, number) =>
          section.label === null ? (
            section.rows.map(renderRow)
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with ARIA groups
            <div
              key={section.group ?? ''}
              role="group"
              aria-labelledby={`${id}-group-${number}`}
              className="not-first:mt-1"
            >
              <div
                id={`${id}-group-${number}`}
                role="presentation"
                className="truncate px-2 pt-1.5 pb-1 text-[11px] font-medium text-subtle"
              >
                {section.label}
              </div>
              {section.rows.map(renderRow)}
            </div>
          ),
        )}
      </div>
      {rows.length === 0 && (
        <p role="status" className="px-3 py-5 text-center text-[12px] text-muted">
          No models match
        </p>
      )}
      {effort && (
        <div className="flex shrink-0 items-center gap-2.5 border-t border-line py-2 pr-2 pl-2.5">
          <span id={effortId} className="shrink-0 text-[12px] text-muted">
            Effort
          </span>
          <fieldset
            aria-labelledby={effortId}
            className="flex min-w-0 flex-1 rounded-md border border-line p-0.5"
          >
            {effort.options.map((choice) => {
              const on = choice.value === effort.value
              return (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={on}
                  title={choice.name}
                  onClick={() => gui.setAgentSetting(effort.id, choice.value)}
                  className={cn(
                    'h-6 min-w-0 flex-auto truncate rounded px-1.5 text-[11.5px] transition-colors',
                    on ? 'bg-hover font-medium text-fg' : 'text-subtle hover:text-fg',
                  )}
                >
                  {choice.name}
                </button>
              )
            })}
          </fieldset>
        </div>
      )}
    </div>,
    document.body,
  )
}
