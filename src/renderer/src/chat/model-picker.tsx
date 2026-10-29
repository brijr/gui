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
import { ChevronDown } from '../lib/icons'
import { motionMs, usePresence } from '../lib/motion'
import {
  GroupLabel,
  MenuRow,
  Popover,
  PopoverNote,
  type PopoverPlacement,
  PopoverSearch,
  placePopover,
} from '../lib/surface'
import { Button, SegmentedControl } from '../lib/ui'
import { useChat } from './store'

type Choice = AgentSetting['options'][number]

/** Lists longer than this get a search field. */
const SEARCH_AFTER = 8
/**
 * Whether the effort levels fit side by side in a picker this wide without cutting any
 * label short; if not, they go one per row. A cautious estimate of the 12px medium text,
 * 7.5px a character, plus each segment's padding and gap, inside the section's padding.
 */
function segmentsFit(labels: string[], width: number) {
  const text = labels.reduce((sum, label) => sum + label.length * 7.5, 0)
  return text + labels.length * 14 <= width - 20
}

/**
 * At most this many frames for the panel to settle before ⇧⌘M opens the picker: the view to
 * stop resizing, and the panel to finish growing out of the pill or the bubble.
 */
const SETTLE_FRAMES = 60

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
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
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
      setPlacement(placePopover(button.current))
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
          setPlacement(placePopover(event.currentTarget))
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
  placement: PopoverPlacement
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
            'group-focus-visible/list:outline-2 group-focus-visible/list:-outline-offset-2 group-focus-visible/list:outline-accent-fg',
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
      placement={placement}
    >
      {searchable && (
        <PopoverSearch
          ref={searchField}
          role="combobox"
          aria-label="Search models"
          aria-controls={listId}
          aria-expanded
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          placeholder="Search models…"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={onListKeyDown}
        />
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
      {rows.length === 0 && <PopoverNote>No models match</PopoverNote>}
      {effort && (
        <div className="flex shrink-0 flex-col gap-1.5 border-t border-line p-2">
          <GroupLabel id={effortId} className="px-1">
            Effort
          </GroupLabel>
          {segmentsFit(effort.options.map(effortLabel), placement.width) ? (
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
            // Too many levels to sit side by side: one per row, like the models, as buttons
            // that apply and leave the picker open.
            <fieldset aria-labelledby={effortId} className="flex flex-col">
              {effort.options.map((choice) => {
                const on = choice.value === effort.value
                return (
                  <MenuRow
                    key={choice.value}
                    as="button"
                    selected={on}
                    aria-pressed={on}
                    onClick={() => gui.setAgentSetting(effort.id, choice.value)}
                  >
                    {effortLabel(choice)}
                  </MenuRow>
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
