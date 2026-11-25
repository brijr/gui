// Parse and write CSS colors in the format they were written in. Named colors are not parsed.
export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'hsl-channels' | 'oklch'
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NUM = '(-?\\d*\\.?\\d+)'
const SEP = '(?:\\s*,\\s*|\\s+)'
const ALPHA = `(?:\\s*[/,]\\s*${NUM}(%)?)?`
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const round = (n: number, d: number) => Number(n.toFixed(d))
const alphaOf = (v?: string, pct?: string) =>
  v === undefined ? 1 : clamp(Number(v) / (pct ? 100 : 1), 0, 1)
const byte = (n: number) => clamp(Math.round(n), 0, 255)

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s = clamp(s, 0, 100) / 100
  l = clamp(l, 0, 100) / 100
  const k = (n: number) => (n + h / 30) % 12
  const f = (n: number) =>
    l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min
  const l = (max + min) / 2
  if (d === 0) return [0, 0, l * 100]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(h * 60 + 360) % 360, s * 100, l * 100]
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLin = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.sign(c) * Math.abs(c) ** (1 / 2.4) - 0.055

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const a = C * Math.cos((H * Math.PI) / 180),
    b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => fromLin(c) * 255) as [number, number, number]
}

function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map((c) => toLin(c / 255))
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360]
}

export function parseColor(text: string): { format: ColorFormat; rgba: Rgba } | null {
  const t = text.trim()
  let m: RegExpMatchArray | null
  m = t.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (m) {
    let h = m[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return {
      format: 'hex',
      rgba: { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? round(n(6) / 255, 3) : 1 },
    }
  }
  m = t.match(
    new RegExp(`^rgba?\\(\\s*${NUM}(%)?${SEP}${NUM}(%)?${SEP}${NUM}(%)?${ALPHA}\\s*\\)$`, 'i'),
  )
  if (m) {
    const c = (v: string, p?: string) => (p ? (Number(v) / 100) * 255 : Number(v))
    return {
      format: 'rgb',
      rgba: {
        r: byte(c(m[1], m[2])),
        g: byte(c(m[3], m[4])),
        b: byte(c(m[5], m[6])),
        a: alphaOf(m[7], m[8]),
      },
    }
  }
  m = t.match(
    new RegExp(`^hsla?\\(\\s*${NUM}(?:deg)?${SEP}${NUM}%${SEP}${NUM}%${ALPHA}\\s*\\)$`, 'i'),
  )
  if (m) {
    const [r, g, b] = hslToRgb(((Number(m[1]) % 360) + 360) % 360, Number(m[2]), Number(m[3]))
    return { format: 'hsl', rgba: { r: byte(r), g: byte(g), b: byte(b), a: alphaOf(m[4], m[5]) } }
  }
  m = t.match(new RegExp(`^${NUM}${SEP}${NUM}%${SEP}${NUM}%$`))
  if (m) {
    const [r, g, b] = hslToRgb(((Number(m[1]) % 360) + 360) % 360, Number(m[2]), Number(m[3]))
    return { format: 'hsl-channels', rgba: { r: byte(r), g: byte(g), b: byte(b), a: 1 } }
  }
  m = t.match(
    new RegExp(`^oklch\\(\\s*${NUM}(%)?${SEP}${NUM}${SEP}${NUM}(?:deg)?${ALPHA}\\s*\\)$`, 'i'),
  )
  if (m) {
    const [r, g, b] = oklchToRgb(
      m[2] ? Number(m[1]) / 100 : Number(m[1]),
      Number(m[3]),
      Number(m[4]),
    )
    return { format: 'oklch', rgba: { r: byte(r), g: byte(g), b: byte(b), a: alphaOf(m[5], m[6]) } }
  }
  return null
}

export function toHex({ r, g, b }: Rgba): string {
  return '#' + [r, g, b].map((c) => byte(c).toString(16).padStart(2, '0')).join('')
}

export function formatColor(rgba: Rgba, format: ColorFormat): string {
  const { r, g, b, a } = rgba
  const alpha = a < 1 ? ` / ${round(a, 3)}` : ''
  switch (format) {
    case 'hex':
      return (
        toHex(rgba) +
        (a < 1
          ? byte(a * 255)
              .toString(16)
              .padStart(2, '0')
          : '')
      )
    case 'rgb':
      return `rgb(${byte(r)} ${byte(g)} ${byte(b)}${alpha})`
    case 'hsl':
    case 'hsl-channels': {
      const [h, s, l] = rgbToHsl(r, g, b).map((v) => round(v, 1))
      return format === 'hsl' ? `hsl(${h} ${s}% ${l}%${alpha})` : `${h} ${s}% ${l}%`
    }
    case 'oklch': {
      const [L, C, H] = rgbToOklch(r, g, b)
      return `oklch(${round(L, 3)} ${round(C, 3)} ${round(H, 3)}${alpha})`
    }
  }
}
