import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { filterCommands } from '../../../shared/commands'
import type { AgentCommand } from '../../../shared/types'
import { gui } from '../lib/api'
import { motionMs, usePresence } from '../lib/motion'
import { MenuRow, Popover } from '../lib/surface'
import { Spinner } from '../lib/ui'

/** `/` and the start of a name, nothing after: the menu's query. Null when it shouldn't open. */
function menuQuery(text: string) {
  return /^\/(\S*)$/.exec(text)?.[1] ?? null
}

/** `/name ` with nothing typed after it yet: the command whose input hint to show. */
function awaitingInput(text: string, commands: AgentCommand[]) {
  const name = /^\/(\S+) $/.exec(text)?.[1]
  return name ? (commands.find((command) => command.name === name && command.hint) ?? null) : null
}

interface CommandMenu {
  /** The menu (or the chosen command's input hint) to draw above the message box */
  element: ReactNode
  /** Props for the message box, which keeps focus and points at the highlighted command */
  inputProps: { 'aria-controls'?: string; 'aria-activedescendant'?: string }
  /** Handles ↑/↓, Enter, Tab and Esc while the menu is open; true when it took the key */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean
}

/**
 * The agent's slash commands, listed as the message starts with `/`. Choosing one puts
 * `/name ` in the message box; Enter on a command already typed out in full sends it.
 */
export function useCommandMenu({
  text,
  commands,
  setText,
  send,
}: {
  text: string
  commands: AgentCommand[]
  setText(text: string): void
  send(): void
}): CommandMenu {
  const id = useId()
  const listId = `${id}-commands`
  const query = menuQuery(text)
  const shown = query === null ? [] : filterCommands(commands, query)
  /** Esc closes the menu for the message as it is; typing opens it again. */
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  // A new chat's agent hasn't started, so it hasn't said what it offers: `/` starts it
  // (nothing is sent) and the menu says it's loading until the commands arrive.
  const awaiting = query !== null && commands.length === 0
  const [loading, setLoading] = useState(false)
  const open = (shown.length > 0 || (awaiting && loading)) && dismissed !== text
  const activeIndex = Math.min(active, shown.length - 1)
  const optionId = (index: number) => `${id}-command-${index}`
  const activeId = open && shown.length > 0 ? optionId(activeIndex) : undefined
  // The list as last shown, kept while the menu closes: by then the query that made it is
  // gone (a command chosen, the message sent or cleared).
  const last = useRef({ shown, activeIndex })
  if (open) last.current = { shown, activeIndex }
  const present = usePresence(open, motionMs('--motion-exit'))

  useEffect(() => {
    if (!awaiting) return
    let live = true
    setLoading(true)
    // Never rejects; an agent that couldn't start just leaves nothing to list.
    void gui.loadCommands().finally(() => {
      if (live) setLoading(false)
    })
    return () => {
      live = false
      setLoading(false)
    }
  }, [awaiting])

  // The best match again whenever the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new query only
  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  const choose = (command: AgentCommand) => setText(`/${command.name} `)

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false
    const command = shown[activeIndex]
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && shown.length > 0) {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + shown.length) % shown.length)
    } else if (event.key === 'Tab' && !event.shiftKey && command) {
      choose(command)
    } else if (event.key === 'Enter' && !event.shiftKey && command) {
      // Typed out in full and taking no input: run it, as Enter would without the menu.
      if (command.name === query && !command.hint) send()
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
              <span className="font-mono">/{command.name}</span>
              {command.description && <span className="text-muted"> {command.description}</span>}
            </MenuRow>
          ))}
        </div>
      ) : (
        // A MenuRow's size and inset, so the list takes its place without a jump.
        <div className="p-1">
          <p role="status" className="flex h-7 items-center gap-2 px-2 text-small text-muted">
            <Spinner />
            Loading commands…
          </p>
        </div>
      )}
    </Popover>
  )

  const hinted = open ? null : awaitingInput(text, commands)
  const element =
    menu || hinted ? (
      <>
        {menu}
        {hinted && (
          <p className="truncate px-1 text-small text-muted">
            <span className="font-mono">/{hinted.name}</span> <span>{hinted.hint}</span>
          </p>
        )}
      </>
    ) : null

  return {
    element,
    inputProps: activeId ? { 'aria-controls': listId, 'aria-activedescendant': activeId } : {},
    onKeyDown,
  }
}
