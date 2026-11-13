import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { Ghostty, type GhosttyCell } from 'ghostty-web'
import { TERMINAL_SCROLLBACK_BYTES } from '../src/shared/bounded'

const text = (cells: GhosttyCell[] | null) =>
  (cells ?? [])
    .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
    .join('')
    .trimEnd()

// Ghostty reads `scrollback` as bytes of page memory, not lines: 5000 kept only a few hundred.
test('a wide terminal keeps 5,000 lines of output in its scrollback', async () => {
  const ghostty = await Ghostty.load(
    join(import.meta.dirname, '../node_modules/ghostty-web/dist/ghostty-vt.wasm'),
  )
  const term = ghostty.createTerminal(240, 40, { scrollbackLimit: TERMINAL_SCROLLBACK_BYTES })
  for (let i = 1; i <= 5000; i++) {
    term.write(`\x1b[32mline ${i}\x1b[0m of some typical build output\r\n`)
  }
  expect(term.getScrollbackLength()).toBeGreaterThanOrEqual(5000 - 40)
  expect(text(term.getScrollbackLine(0))).toBe('line 1 of some typical build output')
  term.free()
})
