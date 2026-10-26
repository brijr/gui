import { describe, expect, test } from 'bun:test'
import { durationBytes, reserveDuration } from '../src/main/webm-duration'

const size = (length: number) =>
  length < 127 ? [0x80 | length] : [0x40 | (length >> 8), length & 0xff]
const element = (id: number[], data: number[]) => [...id, ...size(data.length), ...data]
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

const EBML = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], ascii('webm')))
const SEGMENT = [0x18, 0x53, 0x80, 0x67]
const info = (fields: number[]) => element([0x15, 0x49, 0xa9, 0x66], fields)
const SCALE_MS = element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])
const APP = element([0x4d, 0x80], ascii('Chrome'))
const TRACKS = element([0x16, 0x54, 0xae, 0x6b], [0xae, 0x80])
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN, ...element([0xe7], [0])]

/** Like a recorder's first chunk: a live segment of unknown size. */
function chunk(fields = [...SCALE_MS, ...APP], before: number[] = []) {
  return new Uint8Array([
    ...EBML,
    ...SEGMENT,
    ...UNKNOWN,
    ...before,
    ...info(fields),
    ...TRACKS,
    ...CLUSTER,
  ])
}

const float64 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset).getFloat64(at)

describe('reserveDuration', () => {
  test("adds a zero Duration to a live segment's Info, keeping the rest as it was", () => {
    const original = chunk()
    const reserved = reserveDuration(original)
    if (!reserved) throw new Error('expected a reservation')
    expect(reserved.bytes.length).toBe(original.length + 11)
    expect(reserved.width).toBe(8)
    expect(reserved.scale).toBe(1_000_000)
    // Info's size grew by the new element.
    const infoAt = EBML.length + SEGMENT.length + UNKNOWN.length
    expect(reserved.bytes[infoAt + 4]).toBe(0x80 | (SCALE_MS.length + APP.length + 11))
    expect([...reserved.bytes.subarray(reserved.offset - 3, reserved.offset)]).toEqual([
      0x44, 0x89, 0x88,
    ])
    expect(float64(reserved.bytes, reserved.offset)).toBe(0)
    // The segment stays of unknown size, and what follows Info is untouched.
    expect([...reserved.bytes.subarray(infoAt - 8, infoAt)]).toEqual(UNKNOWN)
    expect([...reserved.bytes.subarray(reserved.offset + 8)]).toEqual([...TRACKS, ...CLUSTER])
  })

  test('the duration is written in the clip’s timecode units', () => {
    const reserved = reserveDuration(chunk())
    if (!reserved) throw new Error('expected a reservation')
    const bytes = durationBytes(1500, reserved)
    expect(new DataView(bytes.buffer).getFloat64(0)).toBe(1500)
    const micro = reserveDuration(chunk([...element([0x2a, 0xd7, 0xb1], [0x03, 0xe8]), ...APP]))
    if (!micro) throw new Error('expected a reservation')
    expect(micro.scale).toBe(1000)
    expect(new DataView(durationBytes(1500, micro).buffer).getFloat64(0)).toBe(1_500_000)
  })

  test('a segment of known size grows by as much', () => {
    const body = [...info([...SCALE_MS]), ...TRACKS]
    const original = new Uint8Array([
      ...EBML,
      ...SEGMENT,
      0x01,
      0,
      0,
      0,
      0,
      0,
      0,
      body.length,
      ...body,
    ])
    const reserved = reserveDuration(original)
    if (!reserved) throw new Error('expected a reservation')
    expect(reserved.bytes[EBML.length + SEGMENT.length + 7]).toBe(body.length + 11)
  })

  test('uses a Duration that is already there', () => {
    const existing = element([0x44, 0x89], [0, 0, 0, 0, 0, 0, 0, 0])
    const original = chunk([...SCALE_MS, ...existing])
    const reserved = reserveDuration(original)
    if (!reserved) throw new Error('expected a reservation')
    expect(reserved.bytes).toBe(original)
    expect(reserved.offset).toBe(original.length - TRACKS.length - CLUSTER.length - 8)
  })

  test('leaves alone what it cannot change safely', () => {
    expect(reserveDuration(new Uint8Array([0, 1, 2, 3]))).toBeNull()
    // A seek index would point past what moved.
    const seekHead = element([0x11, 0x4d, 0x9b, 0x74], [0xec, 0x80])
    expect(reserveDuration(chunk(undefined, seekHead))).toBeNull()
    // Info cut off by the end of the chunk
    expect(reserveDuration(chunk().subarray(0, EBML.length + 14))).toBeNull()
  })
})
