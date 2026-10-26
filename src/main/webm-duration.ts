/**
 * A recorder's WebM has no duration: it's written as it's made. Without one, a player can't
 * show a timeline or seek. The clip is saved as it's recorded, so rather than rewriting the
 * whole file at the end, its first chunk gets a Duration of 0 (`reserveDuration`), and the
 * real one is written over those 8 bytes once the recording stops (`durationBytes`).
 */

const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const SEEK_HEAD = 0x114d9b74
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489
const CLUSTER = 0x1f43b675

export interface ReservedDuration {
  /** The first chunk, with a Duration element in its segment's Info */
  bytes: Uint8Array
  /** Where the Duration's float is, from the start of the file */
  offset: number
  /** 4 or 8 */
  width: number
  /** TimecodeScale: nanoseconds per unit of Duration */
  scale: number
}

interface Element {
  id: number
  /** Where the element starts */
  start: number
  /** Where its data starts */
  data: number
  /** Its data's length; null when unknown (a live segment or cluster) */
  size: number | null
  /** The size field's length in bytes */
  sizeLength: number
}

function readElement(bytes: Uint8Array, at: number): Element | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  const idLength = Math.clz32(first) - 23
  if (idLength > 4 || at + idLength >= bytes.length) return null
  let id = 0
  for (let index = 0; index < idLength; index++) id = id * 256 + bytes[at + index]
  const sizeAt = at + idLength
  const lead = bytes[sizeAt]
  if (lead === undefined || lead === 0) return null
  const sizeLength = Math.clz32(lead) - 23
  if (sizeAt + sizeLength > bytes.length) return null
  let size = lead & (0xff >> sizeLength)
  let unknown = size === 0xff >> sizeLength
  for (let index = 1; index < sizeLength; index++) {
    const byte = bytes[sizeAt + index]
    size = size * 256 + byte
    if (byte !== 0xff) unknown = false
  }
  return { id, start: at, data: sizeAt + sizeLength, size: unknown ? null : size, sizeLength }
}

/** `value` as an EBML size of `length` bytes; null when it doesn't fit. */
function encodeSize(value: number, length: number): Uint8Array | null {
  // All ones means "unknown", so the largest size is one less.
  if (length < 1 || length > 8 || value >= 2 ** (7 * length) - 1) return null
  const out = new Uint8Array(length)
  let rest = value
  for (let index = length - 1; index >= 0; index--) {
    out[index] = rest % 256
    rest = Math.floor(rest / 256)
  }
  out[0] |= 0x80 >> (length - 1)
  return out
}

function children(bytes: Uint8Array, parent: Element) {
  const found: Element[] = []
  const end = parent.size === null ? bytes.length : parent.data + parent.size
  let at = parent.data
  while (at < end) {
    const element = readElement(bytes, at)
    if (!element) break
    found.push(element)
    if (element.size === null) break
    at = element.data + element.size
  }
  return found
}

function readUint(bytes: Uint8Array, element: Element) {
  let value = 0
  for (let index = 0; index < (element.size ?? 0); index++)
    value = value * 256 + bytes[element.data + index]
  return value
}

/**
 * The recorder's first chunk, with room for the duration; null when it isn't a WebM this can
 * change safely (then it's kept as it is, and plays without a known length).
 */
export function reserveDuration(chunk: Uint8Array): ReservedDuration | null {
  const header = readElement(chunk, 0)
  if (!header || header.id !== EBML || header.size === null) return null
  const segment = readElement(chunk, header.data + header.size)
  if (!segment || segment.id !== SEGMENT) return null
  let info: Element | null = null
  for (const child of children(chunk, segment)) {
    // A seek index points at byte positions that adding to Info would move.
    if (child.id === SEEK_HEAD || child.id === CLUSTER) return null
    if (child.id === INFO) {
      info = child
      break
    }
  }
  if (!info || info.size === null || info.data + info.size > chunk.length) return null
  const fields = children(chunk, info)
  const scaleField = fields.find((field) => field.id === TIMECODE_SCALE)
  const scale = scaleField ? readUint(chunk, scaleField) : 1_000_000
  if (!scale) return null
  const existing = fields.find((field) => field.id === DURATION)
  if (existing) {
    if (existing.size !== 4 && existing.size !== 8) return null
    return { bytes: chunk, offset: existing.data, width: existing.size, scale }
  }
  // Duration: ID 0x4489, size 8, a float64 of 0 for now.
  const duration = new Uint8Array([0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0])
  const infoEnd = info.data + info.size
  const infoSize = encodeSize(info.size + duration.length, info.sizeLength)
  if (!infoSize) return null
  // A live segment's size is unknown and stays so; a known one grows by the same amount.
  let segmentSize: Uint8Array | null = null
  if (segment.size !== null) {
    segmentSize = encodeSize(segment.size + duration.length, segment.sizeLength)
    if (!segmentSize) return null
  }
  const bytes = new Uint8Array(chunk.length + duration.length)
  bytes.set(chunk.subarray(0, infoEnd))
  bytes.set(duration, infoEnd)
  bytes.set(chunk.subarray(infoEnd), infoEnd + duration.length)
  bytes.set(infoSize, info.data - info.sizeLength)
  if (segmentSize) bytes.set(segmentSize, segment.data - segment.sizeLength)
  return { bytes, offset: infoEnd + 3, width: 8, scale }
}

/** The bytes to write at `reserved.offset` for a clip `durationMs` long. */
export function durationBytes(
  durationMs: number,
  reserved: Pick<ReservedDuration, 'width' | 'scale'>,
) {
  const units = (durationMs * 1_000_000) / reserved.scale
  const out = new Uint8Array(reserved.width)
  const view = new DataView(out.buffer)
  if (reserved.width === 4) view.setFloat32(0, units)
  else view.setFloat64(0, units)
  return out
}
