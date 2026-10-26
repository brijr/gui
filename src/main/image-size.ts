/**
 * A PNG's or JPEG's pixel size, read from its header without decoding it. Null when the bytes
 * aren't a PNG or JPEG this can read.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  return pngSize(bytes) ?? jpegSize(bytes)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngSize(bytes: Uint8Array) {
  // Signature, then the IHDR chunk: length, "IHDR", width, height (big-endian).
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(12) !== 0x49484452) return null
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function jpegSize(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let at = 2
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]
    // Fill bytes before a marker
    if (marker === 0xff) {
      at++
      continue
    }
    // Markers with no length: TEM and the restart markers
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    // Start of scan or end of image before a frame header: nothing to read.
    if (marker === 0xda || marker === 0xd9) return null
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    if (length < 2) return null
    // Start of frame (SOF0–SOF15, except DHT, JPG and DAC, which share the range):
    // length, precision, height, width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 8 >= bytes.length) return null
      const height = (bytes[at + 5] << 8) | bytes[at + 6]
      const width = (bytes[at + 7] << 8) | bytes[at + 8]
      return width > 0 && height > 0 ? { width, height } : null
    }
    at += 2 + length
  }
  return null
}
