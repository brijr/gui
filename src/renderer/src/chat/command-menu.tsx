import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { commandLabel, commandQuery, filterCommands, insertCommand } from '../../../shared/commands'
import type { AgentCommand } from '../../../shared/types'
import { gui } from '../lib/api'
import { motionMs, usePresence } from '../lib/motion'
import { MenuRow, Popover, PopoverNote } from '../lib/surface'

/** `/name ` with nothing typed after it yet: the command whose input hint to show. */
function awaitingInput(text: string, commands: AgentCommand[]) {
  const name = /^\/(\S+) $/.exec(text)?.[1]
  return name ? (commands.find((command) => command.name === name && command.hint) ?? null) : null
}

interface CommandMenu {
  /** The menu (or the chosen command's input hint) to draw above the message box */
  element: ReactNode
  /** Props for the message box, which keeps focus and points at the highlighted command */
  inputProps: {
    role?: 'combobox'
    'aria-expanded'?: boolean
    'aria-autocomplete'?: 'list'
    'aria-controls'?: string
    'aria-activedescendant'?: string
    onSelect(event: SyntheticEvent<HTMLTextAreaElement>): void
  }
  /** Handles ↑/↓, Enter, Tab and Esc while the menu is open; true when it took the key */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean
}

/**
 * The agent's commands and skills, listed as `/` is typed at the start of the message or
 * after a space. Choosing a slash command puts `/name ` at the front of the message (the
 * rest is its input); a skill goes where the `/` was. Enter on a command already typed
 * out in full as the whole message sends it.
 */
export function useCommandMenu({
  text,
  commands,
  input,
  setText,
  send,
}: {
  text: string
  commands: AgentCommand[]
  /** The message box, to read and place the caret */
  input: RefObject<HTMLTextAreaElement | null>
  setText(text: string): void
  send(): void
}): CommandMenu {
  const id = useId()
  const listId = `${id}-commands`
  // Where the caret was last reported, for the message as it was then: a change without
  // one (pasted, filled in) leaves it at the end. -1 while text is selected: no menu.
  const [caret, setCaret] = useState<{ text: string; at: number } | null>(null)
  const at =
    caret?.text !== text
      ? commandQuery(text)
      : caret.at === -1
        ? null
        : commandQuery(text, caret.at)
  const query = at?.query ?? null
  const shown = query === null ? [] : filterCommands(commands, query)
  /** Esc closes the menu for the message as it is; typing opens it again. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  // A new chat's agent hasn't started, so it hasn't said what it offers: `/` starts it
  // (nothing is sent; main does nothing once it knows them) and the menu says it's loading
  // until the commands arrive, then that there are none if the agent offers none (or
  // couldn't start). Skills Gui found on disk can show meanwhile.
  const asking = query !== null
  const awaiting = asking && commands.length === 0
  const [checked, setChecked] = useState(false)
  const open = (shown.length > 0 || awaiting) && dismissed !== text
  const activeIndex = Math.min(active, shown.length - 1)
  const optionId = (index: number) => `${id}-command-${index}`
  const activeId = open && shown.length > 0 ? optionId(activeIndex) : undefined
  // The list as last shown, kept while the menu closes: by then the query that made it is
  // gone (a command chosen, the message sent or cleared).
  const last = useRef({ shown, activeIndex })
  if (open) last.current = { shown, activeIndex }
  const present = usePresence(open, motionMs('--motion-exit'))

  useEffect(() => {
    if (!asking) return
    let live = true
    setChecked(false)
    // Never rejects; an agent that couldn't start just leaves nothing to list.
    void gui.loadCommands().finally(() => {
      if (live) setChecked(true)
    })
    return () => {
      live = false
    }
  }, [asking])

  // The best match again whenever the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new query only
  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const choose = (command: AgentCommand) => {
    if (!at) return
    const next = insertCommand(text, at, command)
    setText(next.text)
    setCaret({ text: next.text, at: next.caret })
    // After React writes the new value, which would leave the caret at the end.
    requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret))
  }

  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const box = event.currentTarget
    const at = box.selectionStart === box.selectionEnd ? box.selectionStart : -1
    setCaret({ text: box.value, at })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false
    const command = shown[activeIndex]
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && shown.length > 0) {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + shown.length) % shown.length)
    } else if (event.key === 'Tab' && !event.shiftKey && command) {
      choose(command)
    } else if (event.key === 'Enter' && !event.shiftKey && command) {
      // Typed out in full as the whole message and taking no input: run it, as Enter
      // would without the menu.
      if (`/${command.name}` === text && !command.hint) send()
      else choose(command)
    } else if (event.key === 'Escape') {
      setDismissed(text)
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  const rows = open ? shown : last.current.shown
  const highlighted = open ? activeIndex : last.current.activeIndex
  const menu = present && (
    // In the composer's stack, right above the message box: it grows up out of the box.
    <Popover
      instant
      open={open}
      // Focus stays in the message box; clicks mustn't take it.
      onMouseDown={(event) => event.preventDefault()}
      style={{ transformOrigin: '0 100%' }}
      className="max-h-56 shrink-0"
    >
      {rows.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Commands"
          className="min-h-0 overflow-y-auto scroll-stable overscroll-contain p-1"
        >
          {rows.map((command, index) => (
            <MenuRow
              key={command.name}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlighted}
              title={command.description || undefined}
              highlighted={index === highlighted}
              selected={false}
              onPointerMove={() => {
                if (index !== activeIndex) setActive(index)
              }}
              onClick={() => choose(command)}
            >
              <span className="font-mono">{commandLabel(command)}</span>
              {command.description && <span className="text-muted"> {command.description}</span>}
            </MenuRow>
          ))}
        </div>
      ) : (
        <PopoverNote loading={!checked}>
          {checked ? 'No commands available' : 'Loading commands…'}
        </PopoverNote>
      )}
    </Popover>
  )

  const hinted = open ? null : awaitingInput(text, commands)
  const element =
    menu || hinted ? (
      <>
        {menu}
        {hinted && (
          <p
            title={`/${hinted.name} ${hinted.hint ?? ''}`}
            className="truncate px-1 text-small text-muted"
          >
            <span className="font-mono">/{hinted.name}</span> <span>{hinted.hint}</span>
          </p>
        )}
      </>
    ) : null

  return {
    element,
    // A combobox only while its list shows: otherwise it's the plain message box it looks like.
    inputProps: activeId
      ? {
          role: 'combobox',
          'aria-expanded': true,
          'aria-autocomplete': 'list',
          'aria-controls': listId,
          'aria-activedescendant': activeId,
          onSelect,
        }
      : { onSelect },
    onKeyDown,
  }
}
