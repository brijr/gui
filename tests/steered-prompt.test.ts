import { describe, expect, test } from 'bun:test'
import { describeFollowUp, describeSteeredBefore } from '../src/main/prompt'
import type { Turn } from '../src/shared/types'

// Messages the user sends into a reply while it's under way (steering) are part of what they
// asked in that turn: a follow-up on the turn, or a retry of it, carries them too.

const text = (blocks: ReturnType<typeof describeFollowUp>) =>
  blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

const turn: Turn = {
  id: 't1',
  index: 2,
  prompt: 'Make the header blue',
  context: [],
  items: [
    { kind: 'text', id: 'a', text: 'Changing the header.' },
    { kind: 'steer', id: 's1', prompt: 'Darker blue', context: [] },
    { kind: 'text', id: 'b', text: ' Done.' },
    { kind: 'steer', id: 's2', prompt: 'And the footer\ntoo', context: [] },
  ],
  status: 'done',
  error: null,
  startedAt: 0,
  endedAt: 1,
  changes: null,
  reverted: false,
}

describe('steered messages', () => {
  test('a follow-up quotes them after what the user first asked, in order', () => {
    const said = text(describeFollowUp(turn, false))
    expect(said).toContain(
      'They asked:\n> Make the header blue\nWhile you worked on it, they added:',
    )
    expect(said).toContain('> Darker blue\n> And the footer\n> too')
    expect(said.indexOf('Darker blue')).toBeLessThan(said.indexOf('You replied:'))
    // They aren't the agent's reply.
    expect(said).toContain('> Changing the header. Done.')
  })

  test('a follow-up on a turn without them says nothing of them', () => {
    const plain = { ...turn, items: turn.items.filter((item) => item.kind !== 'steer') }
    expect(text(describeFollowUp(plain, false))).not.toContain('they added')
  })

  test('a retry carries them, quoted, and nothing when there were none', () => {
    expect(describeSteeredBefore([])).toEqual([])
    expect(text(describeSteeredBefore(['Darker blue', 'And the footer']))).toBe(
      'When this message was sent before, the user added this while you worked on it:\n> Darker blue\n> And the footer',
    )
  })
})
