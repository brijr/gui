import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Ghostty } from 'ghostty-web'
import { drawOutput } from '../src/renderer/src/app/terminal-output'
import type { OutputChunk } from '../src/shared/ipc'

/** Main's side of one view: its snapshot, what it sends, and what the view acknowledged. */
function fakeMain(snapshot: OutputChunk) {
  let send: ((chunk: OutputChunk) => void) | null = null
  const acks: number[] = []
  return {
    acks,
    send: (chunk: OutputChunk) => send?.(chunk),
    source: {
      snapshot: async () => snapshot,
      subscribe: (cb: (chunk: OutputChunk) => void) => {
        send = cb
        return () => {
          send = null
        }
      },
      ack: (_id: string, end: number) => acks.push(end),
    },
  }
}

/** A terminal that draws, until told to throw as Ghostty does once its memory is past 2 GB. */
function fakeTerminal() {
  const terminal = {
    written: [] as string[],
    throws: false,
    outgrown: false,
    write(data: string) {
      if (terminal.throws) throw new RangeError('offset is out of bounds')
      terminal.written.push(data)
    },
  }
  return { terminal, target: { write: terminal.write, outgrown: () => terminal.outgrown } }
}

const chunk = (data: string, end: number): OutputChunk => ({ id: 'term-1', data, end })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let reports: unknown[]
beforeEach(() => {
  reports = []
  ;(globalThis as { window?: unknown }).window = {
    gui: { reportError: (report: unknown) => reports.push(report) },
  }
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('drawing a terminal’s output', () => {
  test('a write that throws is still acknowledged, reported once, and the view is made again', async () => {
    const main = fakeMain(chunk('$ ', 2))
    const { terminal, target } = fakeTerminal()
    let remounts = 0
    drawOutput(target, main.source, () => remounts++)
    await settle()
    expect(main.acks).toEqual([2])

    terminal.throws = true
    main.send(chunk('ls\r\n', 6))
    // Main isn't left holding the shell for a view that can't draw.
    expect(main.acks).toEqual([2, 6])
    expect(remounts).toBe(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ message: 'offset is out of bounds' })

    // Until it's made again, what comes is acknowledged, not drawn, and not asked for again.
    main.send(chunk('a\r\n', 9))
    expect(main.acks).toEqual([2, 6, 9])
    expect(remounts).toBe(1)
    expect(reports).toHaveLength(1)
  })

  test('a new terminal that can’t draw main’s snapshot isn’t made again in a loop', async () => {
    const main = fakeMain(chunk('$ ', 2))
    const { terminal, target } = fakeTerminal()
    terminal.throws = true
    let remounts = 0
    drawOutput(target, main.source, () => remounts++)
    await settle()
    main.send(chunk('ls\r\n', 6))
    main.send(chunk('a\r\n', 9))
    expect(main.acks).toEqual([2, 6, 9])
    expect(remounts).toBe(0)
    expect(reports).toHaveLength(1)
  })

  test('a terminal past its memory is made again once', async () => {
    const main = fakeMain(chunk('$ ', 2))
    const { terminal, target } = fakeTerminal()
    let remounts = 0
    drawOutput(target, main.source, () => remounts++)
    await settle()
    terminal.outgrown = true
    main.send(chunk('ls\r\n', 6))
    main.send(chunk('a\r\n', 9))
    expect(terminal.written).toEqual(['$ ', 'ls\r\n'])
    expect(main.acks).toEqual([2, 6, 9])
    expect(remounts).toBe(1)
    expect(reports).toHaveLength(0)
  })
})

// Why a terminal has a Ghostty of its own, made again past a size: Ghostty 0.4 leaks in its
// WebAssembly memory, which only grows. Once that passes 2 GB its pointers are negative in
// JavaScript and every write throws "offset is out of bounds". If this starts failing, an
// update fixed the leak.
describe('ghostty-web 0.4', () => {
  const wasm = `${import.meta.dirname}/../node_modules/ghostty-web/dist/ghostty-vt.wasm`
  const config = { scrollbackLimit: 5000, fgColor: 0, bgColor: 0, cursorColor: 0, palette: [] }

  async function growth(colors: number) {
    const ghostty = await Ghostty.load(wasm)
    const memory = (ghostty as unknown as { memory: WebAssembly.Memory }).memory
    const terminal = ghostty.createTerminal(80, 24, config)
    let text = ''
    for (let line = 0; line < 8000; line++) text += `\x1b[38;5;${line % colors}mx\x1b[0m\r\n`
    // Twice: the first fills the scrollback, which may grow the memory once.
    terminal.write(text)
    const filled = memory.buffer.byteLength
    terminal.write(text)
    terminal.free()
    return memory.buffer.byteLength - filled
  }

  test('leaks once a page of output has more than about a hundred colors', async () => {
    expect(await growth(16)).toBe(0)
    expect(await growth(200)).toBeGreaterThan(8 * 1024 * 1024)
  })
})
