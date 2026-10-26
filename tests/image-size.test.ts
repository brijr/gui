import { describe, expect, test } from 'bun:test'
import { imageSize } from '../src/main/image-size'

/** A JPEG's start: SOI, an APP0 segment, then a baseline or progressive frame header. */
function jpeg(width: number, height: number, sof = 0xc0, extra: number[] = []) {
  return new Uint8Array([
    0xff,
    0xd8,
    // APP0 (JFIF), length 16
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Array.from({ length: 14 }, () => 0),
    ...extra,
    // SOFn: length 17, precision 8, height, width, 3 components
    0xff,
    sof,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    ...Array.from({ length: 9 }, () => 0),
    0xff,
    0xda,
  ])
}

function png(width: number, height: number) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe('imageSize', () => {
  test("reads a JPEG's size from its frame header", () => {
    expect(imageSize(jpeg(1568, 980))).toEqual({ width: 1568, height: 980 })
    // Progressive
    expect(imageSize(jpeg(640, 480, 0xc2))).toEqual({ width: 640, height: 480 })
  })

  test('skips other segments, including DHT, which shares the frame markers', () => {
    const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]
    expect(imageSize(jpeg(320, 200, 0xc0, dht))).toEqual({ width: 320, height: 200 })
    const fill = [0xff, 0xff]
    expect(imageSize(jpeg(320, 200, 0xc0, fill))).toEqual({ width: 320, height: 200 })
  })

  test("reads a PNG's size from IHDR", () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  test('null for anything else, a cut-off header, or a zero size', () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(imageSize(jpeg(320, 200).subarray(0, 24))).toBeNull()
    expect(imageSize(jpeg(0, 200))).toBeNull()
    expect(imageSize(png(10, 10).subarray(0, 20))).toBeNull()
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull()
  })
})
