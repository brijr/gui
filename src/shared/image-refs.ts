const REF = /\[Image (\d+)\]/g

export const imageRef = (n: number) => `[Image ${n}]`

export function writtenText(text: string) {
  const trimmed = text.trim()
  return trimmed.replace(REF, '').trim() ? trimmed : ''
}

export function dropImageRef(text: string, n: number) {
  return text.replace(
    /( ?)\[Image (\d+)\]( ?)/g,
    (ref, before: string, digits: string, after: string) => {
      const k = Number(digits)
      if (k > n) return `${before}${imageRef(k - 1)}${after}`
      if (k < n) return ref
      return before && after ? ' ' : ''
    },
  )
}

export function imageRefParts(text: string): (string | number)[] {
  const parts: (string | number)[] = []
  let cursor = 0
  for (const match of text.matchAll(REF)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    parts.push(Number(match[1]))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}
