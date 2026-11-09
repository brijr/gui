import { describe, expect, test } from 'bun:test'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { placeCommand } from '../src/main/prompt'
import {
  commandLabel,
  commandQuery,
  filterCommands,
  insertCommand,
  invokedCommand,
  takesContext,
} from '../src/shared/commands'
import type { AgentCommand } from '../src/shared/types'

const command = (name: string, extra: Partial<AgentCommand> = {}): AgentCommand => ({
  name,
  description: '',
  hint: null,
  ...extra,
})

/** `text` with `|` marking the caret, as the menu sees it. */
const at = (marked: string) => {
  const caret = marked.indexOf('|')
  return { text: marked.replace('|', ''), caret }
}

const choose = (marked: string, chosen: AgentCommand) => {
  const { text, caret } = at(marked)
  const query = commandQuery(text, caret)
  if (!query) throw new Error(`no query in ${marked}`)
  const next = insertCommand(text, query, chosen)
  return `${next.text.slice(0, next.caret)}|${next.text.slice(next.caret)}`
}

describe('commandQuery', () => {
  test('opens at the start of the message', () => {
    expect(commandQuery('/')).toEqual({ query: '', start: 0, end: 1 })
    expect(commandQuery('/rev')).toEqual({ query: 'rev', start: 0, end: 4 })
  })

  test('opens after a space anywhere in the message', () => {
    const text = 'animate these coming in smoothly and cleanly /emil-'
    expect(commandQuery(text)?.query).toBe('emil-')
    expect(commandQuery('first line\n/re')?.query).toBe('re')
  })

  test('follows the caret, not the end of the message', () => {
    const { text, caret } = at('make /emi| smoother')
    expect(commandQuery(text, caret)).toEqual({ query: 'emi', start: 5, end: 9 })
  })

  test("doesn't open inside a word, a URL or a path", () => {
    expect(commandQuery('and/or')).toBeNull()
    expect(commandQuery('see https://example.com/docs')).toBeNull()
    expect(commandQuery('edit /src/app')).toBeNull()
    const { text, caret } = at('make /emi|x smoother')
    expect(commandQuery(text, caret)).toBeNull()
  })

  test('closes once a space follows the name', () => {
    expect(commandQuery('/review ')).toBeNull()
    expect(commandQuery('fix /review this')).toBeNull()
  })
})

describe('insertCommand', () => {
  test('a slash command typed at the start is just put there', () => {
    expect(choose('/rev|', command('review'))).toBe('/review |')
  })

  test('a slash command typed later moves to the front; the rest is its input', () => {
    expect(
      choose('animate these coming in smoothly and cleanly /emil-|', command('emil-animations')),
    ).toBe('/emil-animations animate these coming in smoothly and cleanly|')
    expect(choose('make /emi| smoother', command('emil-animations'))).toBe(
      '/emil-animations make |smoother',
    )
  })

  test("Codex's $skills are written as $name where they're typed", () => {
    const skill = command('$emil-animations')
    expect(choose('animate these /emil|', skill)).toBe('animate these $emil-animations |')
    expect(choose('/emil| this', skill)).toBe('$emil-animations| this')
  })

  test('a plain-words skill becomes a sentence where it was typed', () => {
    const skill = command('emil-animations', { skill: true })
    expect(choose('/emil|', skill)).toBe('Use the emil-animations skill |')
    expect(choose('/emil| to animate this', skill)).toBe(
      'Use the emil-animations skill |to animate this',
    )
    expect(choose('animate these smoothly /emil|', skill)).toBe(
      'animate these smoothly. Use the emil-animations skill. |',
    )
    expect(choose('Animate these. /emil|', skill)).toBe(
      'Animate these. Use the emil-animations skill. |',
    )
    expect(choose('animate these, /emil|', skill)).toBe(
      'animate these. Use the emil-animations skill. |',
    )
  })
})

describe('commands as the agent gets them', () => {
  const commands = [
    command('compact'),
    command('emil-animations'),
    command('$imagegen'),
    command('frontend', { skill: true }),
  ]

  test('only a leading slash command the agent offers is a command', () => {
    expect(invokedCommand('/emil-animations make this smoother', commands)?.name).toBe(
      'emil-animations',
    )
    expect(invokedCommand('/compact', commands)?.name).toBe('compact')
    expect(invokedCommand('make this smoother /emil-animations', commands)).toBeNull()
    expect(invokedCommand('/$imagegen a cat', commands)).toBeNull()
    expect(invokedCommand('/frontend', commands)).toBeNull()
    expect(invokedCommand('/src/app.tsx is broken', commands)).toBeNull()
  })

  test('session commands go alone; skills and prompts take the context along', () => {
    expect(takesContext(command('compact'))).toBe(false)
    expect(takesContext(command('rename'))).toBe(false)
    expect(takesContext(command('context'))).toBe(false)
    expect(takesContext(command('emil-animations'))).toBe(true)
    expect(takesContext(command('review'))).toBe(true)
  })

  test('the menu shows each as it is typed', () => {
    expect(commands.map(commandLabel)).toEqual([
      '/compact',
      '/emil-animations',
      '$imagegen',
      'frontend',
    ])
  })

  test('$skills match without their $', () => {
    expect(filterCommands(commands, 'img').map((c) => c.name)).toEqual([])
    expect(filterCommands(commands, 'image').map((c) => c.name)).toEqual(['$imagegen'])
    expect(filterCommands(commands, '$imag').map((c) => c.name)).toEqual(['$imagegen'])
  })
})

describe('placeCommand', () => {
  const context: ContentBlock[] = [
    { type: 'text', text: '<selected_element_1>…</selected_element_1>' },
    { type: 'image', mimeType: 'image/png', data: 'AAAA' },
  ]

  test('alone, a command is the whole prompt', () => {
    expect(placeCommand('/compact', [], 'claude')).toEqual([{ type: 'text', text: '/compact' }])
    expect(placeCommand('/compact', [], 'codex')).toEqual([{ type: 'text', text: '/compact' }])
  })

  test('Claude Code reads the last text block as the command', () => {
    const blocks = placeCommand('/emil-animations make this smoother', context, 'claude')
    expect(blocks.at(-1)).toEqual({ type: 'text', text: '/emil-animations make this smoother' })
    expect(blocks.slice(0, -1)).toEqual(context)
  })

  test('other agents read it from the first block', () => {
    const blocks = placeCommand('/review focus on motion', context, 'opencode')
    expect(blocks[0]).toEqual({ type: 'text', text: '/review focus on motion\n\n' })
    expect(blocks.slice(1)).toEqual(context)
  })
})
