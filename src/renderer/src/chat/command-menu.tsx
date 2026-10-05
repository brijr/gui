import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from 'react'
import { filterCommands } from '../../../shared/commands'
import type { AgentCommand } from '../../../shared/types'
import { Card, MenuRow } from '../lib/surface'

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
  const open = shown.length > 0 && dismissed !== text
  const activeIndex = Math.min(active, shown.length - 1)
  const optionId = (index: number) => `${id}-command-${index}`
  const activeId = open ? optionId(activeIndex) : undefined

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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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

  const hinted = open ? null : awaitingInput(text, commands)
  const element = open ? (
    <Card
      tone="raised"
      id={listId}
      role="listbox"
      aria-label="Commands"
      // Focus stays in the message box; clicks mustn't take it.
      onMouseDown={(event) => event.preventDefault()}
      className="max-h-56 overflow-y-auto scroll-stable overscroll-contain p-1"
    >
      {shown.map((command, index) => (
        <MenuRow
          key={command.name}
          id={optionId(index)}
          role="option"
          aria-selected={index === activeIndex}
          title={command.description || undefined}
          highlighted={index === activeIndex}
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
    </Card>
  ) : hinted ? (
    <p className="truncate px-1 text-small text-muted">
      <span className="font-mono">/{hinted.name}</span> <span>{hinted.hint}</span>
    </p>
  ) : null

  return {
    element,
    inputProps: open ? { 'aria-controls': listId, 'aria-activedescendant': activeId } : {},
    onKeyDown,
  }
}
