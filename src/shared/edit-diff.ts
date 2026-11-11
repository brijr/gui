import { MAX_DIFF_COMPARE, MAX_DIFF_LINE_CHARS, MAX_PERMISSION_DIFF_LINES } from './bounded'
import type { EditDiff } from './types'

type Line = EditDiff['lines'][number]

/**
 * The lines an edit removes and adds, in file order, without the ones it keeps: what's the
 * same at the start and end is left out, and the rest is compared line by line while it's
 * small enough (`MAX_DIFF_COMPARE`); past that, it all counts as changed.
 */
export function changedLines(oldText: string | null, newText: string): Line[] {
  const before = oldText ? oldText.split('\n') : []
  const after = newText ? newText.split('\n') : []
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++
  const a = before.slice(start, before.length - end)
  const b = after.slice(start, after.length - end)
  if (a.length * b.length > MAX_DIFF_COMPARE) {
    return [
      ...a.map((text): Line => ({ sign: '-', text })),
      ...b.map((text): Line => ({ sign: '+', text })),
    ]
  }
  // Longest common subsequence, from the end, so the walk below goes front to back.
  const width = b.length + 1
  const common = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1])
    }
  }
  const lines: Line[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (
      j >= b.length ||
      (i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])
    ) {
      lines.push({ sign: '-', text: a[i++] })
    } else {
      lines.push({ sign: '+', text: b[j++] })
    }
  }
  return lines
}

/**
 * The edits a permission request carries, file by file, kept to `MAX_PERMISSION_DIFF_LINES`
 * changed lines in all (each cut to `MAX_DIFF_LINE_CHARS`). The text is the agent's and the
 * page's: it's shown as text, never as markup.
 */
export function editDiffs(
  edits: { path: string; oldText?: string | null; newText: string }[],
): EditDiff[] {
  let room = MAX_PERMISSION_DIFF_LINES
  return edits.flatMap(({ path, oldText, newText }) => {
    const lines = changedLines(oldText ?? null, newText)
    if (lines.length === 0) return []
    const kept = lines.slice(0, Math.max(0, room)).map(({ sign, text }) => ({
      sign,
      text: text.length > MAX_DIFF_LINE_CHARS ? `${text.slice(0, MAX_DIFF_LINE_CHARS)}…` : text,
    }))
    room -= kept.length
    return [{ path, lines: kept, more: lines.length - kept.length }]
  })
}
