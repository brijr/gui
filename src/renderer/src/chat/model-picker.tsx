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
import { ariaShortcut, withShortcut } from '../../../shared/shortcuts'
import type { AgentSetting, ModelSettings } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Check, ChevronDown, Search } from '../lib/icons'
import { motionMs, usePresence } from '../lib/motion'
import { GroupLabel, MenuRow, Popover } from '../lib/surface'
import { Button, PRESS, SegmentedControl } from '../lib/ui'
import { useChat } from './store'

type Choice = AgentSetting['options'][number]

/** Lists longer than this get a search field. */
const SEARCH_AFTER = 8
/** Room kept between the picker and the panel's edges. */
const EDGE = 8
/** Between the picker and the button. */
const GAP = 4
const WIDTH = 336
/** In a tall panel the list stops growing here and scrolls. */
const MAX_HEIGHT = 440
/** Effort levels side by side up to this many; more go one per row. */
const SEGMENTS_MAX = 6
/**
 * At most this many frames for the panel to settle before ⇧⌘M opens the picker: the view to
 * stop resizing, and the panel to finish growing out of the pill or the bubble.
 */
const SETTLE_FRAMES = 60

/** Where the picker goes, in the chat view's CSS pixels. */
interface Placement {
  left: number
  width: number
  maxHeight: number
  /** From the view's bottom edge when it opens above the button, else null */
  bottom: number | null
  /** From the view's top edge when it opens below the button, else null */
  top: number | null
  /** Where it grows from: the middle of the button's edge it opens from, in its own box */
  origin: string
}

/**
 * Against the button's right edge, above it unless there's more room below. The chat is
 * its own view and can't draw outside it, so the picker stays inside the panel and takes
 * the height there is. Inside the composer it opens off the composer's frame rather than the
 * button, so it doesn't cover the frame's edge.
 */
function place(button: HTMLElement): Placement {
  const panel = (button.closest('[data-chat-panel]') ?? document.body).getBoundingClientRect()
  const box = button.getBoundingClientRect()
  const frame = button.closest('[data-popover-anchor]')?.getBoundingClientRect() ?? box
  // Across from the button; above or below the frame.
  const at = {
    left: box.left,
    right: box.right,
    width: box.width,
    top: frame.top,
    bottom: frame.bottom,
  }
  const width = Math.min(WIDTH, panel.width - EDGE * 2)
  const left = Math.max(panel.left + EDGE, Math.min(at.right - width, panel.right - EDGE - width))
  const above = at.top - GAP - panel.top - EDGE
  const below = panel.bottom - EDGE - at.bottom - GAP
  const x = Math.round(Math.min(Math.max(at.left + at.width / 2 - left, 0), width))
  return above >= below
    ? {
        left,
        width,
        maxHeight: Math.min(MAX_HEIGHT, above),
        bottom: window.innerHeight - at.top + GAP,
        top: null,
        origin: `${x}px 100%`,
      }
    : {
        left,
        width,
        maxHeight: Math.min(MAX_HEIGHT, below),
        bottom: null,
        top: at.bottom + GAP,
        origin: `${x}px 0`,
      }
}

/**
 * Calls `fn` once the view has kept its size for a frame, or after `frames`. ⇧⌘M can bring
 * the panel back as it asks (from minimized, say), and the picker closes on a resize.
 */
function whenSettled(button: HTMLElement | null, fn: () => void, frames = SETTLE_FRAMES) {
  let size = `${window.innerWidth}×${window.innerHeight}`
  let left = frames
  // The panel scales while it morphs (morph.ts); measured then, the picker would be misplaced.
  const morphing = () => !!button?.closest<HTMLElement>('[data-chat-form]')?.style.transform
  const check = () => {
    const now = `${window.innerWidth}×${window.innerHeight}`
    if ((now === size && !morphing()) || --left <= 0) return fn()
    size = now
    requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

/** The selected choice's name; null when the agent reports a value it doesn't list. */
function choiceName(setting: AgentSetting) {
  return setting.options.find((option) => option.value === setting.value)?.name ?? null
}

/**
 * Gui's own names for the effort levels agents share, so they read the same whichever
 * agent offers them ("xhigh" isn't "Xhigh"). Any other level keeps the agent's name.
 */
const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

function effortLabel(choice: { value: string; name: string }) {
  return Object.hasOwn(EFFORT_LABELS, choice.value) ? EFFORT_LABELS[choice.value] : choice.name
}

/** The selected effort's label; the raw value when the agent reports one it doesn't list. */
function effortName(setting: AgentSetting) {
  const choice = setting.options.find((option) => option.value === setting.value)
  return choice ? effortLabel(choice) : setting.value
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
  const [open, setOpen] = useState(false)
  // Kept while it closes, which it does where it was.
  const [placement, setPlacement] = useState<Placement | null>(null)
  const shown = usePresence(open, motionMs('--motion-exit'))
  const button = useRef<HTMLButtonElement>(null)
  const pickerId = useId()
  const fullName = choiceName(models.model) ?? models.model.value
  const model = shortName(fullName)
  const effort = models.effort && effortName(models.effort)
  const pickModel = useChat((s) => s.pickModel)

  // ⇧⌘M (Agent → Choose Model…): open, searching.
  useEffect(() => {
    if (!pickModel) return
    useChat.setState({ pickModel: false })
    whenSettled(button.current, () => {
      if (!button.current) return
      setPlacement(place(button.current))
      setOpen(true)
    })
  }, [pickModel])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }

  return (
    <>
      <Button
        ref={button}
        variant="ghost"
        trailingIcon={ChevronDown}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        aria-label={effort ? `Model: ${model}, effort ${effort}` : `Model: ${model}`}
        title={withShortcut(effort ? `${fullName} · ${effort}` : fullName, 'chooseModel')}
        aria-keyshortcuts={ariaShortcut('chooseModel')}
        onClick={(event) => {
          if (open) return close(false)
          setPlacement(place(event.currentTarget))
          setOpen(true)
        }}
        // Pressed while its picker is open, as a pressed IconButton.
        className="min-w-0 aria-expanded:bg-accent-soft aria-expanded:text-accent-text"
      >
        {/* A long model name gives way; the effort stays readable, unless the row is too
            narrow for both (the floating chat's default width), when it's left to the
            tooltip and the picker so the model name reads whole rather than "Sonne…". */}
        <span className="flex min-w-0">
          <span className="truncate">{model}</span>
          {effort && <span className="shrink-0 whitespace-pre @max-sm:hidden"> · {effort}</span>}
        </span>
      </Button>
      {shown && placement && (
        <ModelPicker
          // A fresh picker for each opening; the one closing goes as it was.
          key={`${placement.left},${placement.top},${placement.bottom}`}
          id={pickerId}
          open={open}
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
  /** False while it closes */
  open: boolean
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
function ModelPicker({ id, open, models, placement, button, onClose }: ModelPickerProps) {
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

  // On opening, and on opening again while it closed.
  useEffect(() => {
    if (open) (searchField.current ?? list.current)?.focus()
  }, [open])

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  // A click elsewhere in the chat, or anywhere outside it (the view loses focus), closes
  // it; so does a resize, which moves the button.
  useEffect(() => {
    if (!open) return
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
  }, [open, button, onClose])

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
      <MenuRow
        key={choice.value}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        title={choice.name}
        highlighted={index === activeIndex}
        selected={selected}
        // With the keyboard in the list, the row the arrows are on is ringed, so it reads
        // apart from a row the pointer only passes over.
        className={cn(
          index === activeIndex &&
            'group-focus-visible/list:outline-2 group-focus-visible/list:-outline-offset-2 group-focus-visible/list:outline-accent',
        )}
        onPointerMove={() => {
          if (index !== activeIndex) setActive(choice.value)
        }}
        onClick={() => pick(choice)}
      >
        {rowName(choice)}
      </MenuRow>
    )
  }

  return createPortal(
    <Popover
      ref={root}
      id={id}
      open={open}
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
        transformOrigin: placement.origin,
      }}
      className="fixed z-popover"
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
            // Unframed in the popover's top edge: the caret shows focus, the placeholder a
            // field's color.
            className="h-9 min-w-0 flex-1 bg-transparent text-fg outline-none focus-visible:outline-none placeholder:text-subtle"
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
        // The list's own focus ring would wrap the whole popover: the highlighted row shows it.
        className={cn(
          'group/list min-h-0 overflow-y-auto scroll-stable overscroll-contain outline-none',
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
              <GroupLabel
                as="div"
                id={`${id}-group-${number}`}
                className="truncate px-2 pt-1.5 pb-1"
              >
                {section.label}
              </GroupLabel>
              {section.rows.map(renderRow)}
            </div>
          ),
        )}
      </div>
      {rows.length === 0 && (
        <p role="status" className="px-3 py-5 text-small text-muted">
          No models match
        </p>
      )}
      {effort && (
        <div className="flex shrink-0 flex-col gap-1.5 border-t border-line p-2">
          <GroupLabel id={effortId} className="px-1">
            Effort
          </GroupLabel>
          {effort.options.length <= SEGMENTS_MAX ? (
            <SegmentedControl
              labelledBy={effortId}
              segments={effort.options.map((choice) => ({
                value: choice.value,
                label: effortLabel(choice),
                title: effortLabel(choice),
              }))}
              value={effort.value}
              onChange={(value) => gui.setAgentSetting(effort.id, value)}
              stretch
            />
          ) : (
            // Too many levels to sit side by side: one per row, like the models.
            <fieldset aria-labelledby={effortId} className="flex flex-col">
              {effort.options.map((choice) => {
                const on = choice.value === effort.value
                return (
                  <button
                    key={choice.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => gui.setAgentSetting(effort.id, choice.value)}
                    // A MenuRow's look, as a button: these apply and leave the picker open.
                    className={cn(
                      'flex h-7 items-center gap-2 rounded-md px-2 text-left text-small transition-[background-color,opacity] hover:bg-hover',
                      PRESS,
                      on && 'text-accent-text',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{effortLabel(choice)}</span>
                    {on && (
                      <Check className="size-3 shrink-0 text-accent-text" aria-hidden="true" />
                    )}
                  </button>
                )
              })}
            </fieldset>
          )}
        </div>
      )}
    </Popover>,
    document.body,
  )
}
