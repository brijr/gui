import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileResponse, parseRange } from '../src/main/byte-range'

describe('parseRange', () => {
  test('no header, or one it does not understand, is the whole file', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
  })

  test('a closed range, clamped to the file', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
  })

  test('an open-ended range runs to the end', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=42-', 100)).toEqual({ start: 42, end: 99 })
  })

  test('a suffix is the last bytes', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  test('past the end, backwards, or empty is unsatisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })
})

describe('fileResponse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gui-range-'))
  afterAll(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'clip.webm')
  const content = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
  await writeFile(file, content)
  const request = (range?: string, method = 'GET') => ({
    method,
    headers: new Headers(range ? { range } : {}),
  })
  const body = async (response: Response) => Buffer.from(await response.arrayBuffer())

  test('the whole file, with its length and that it takes ranges', async () => {
    const response = await fileResponse(file, request(), { 'Content-Type': 'video/webm' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('256')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-type')).toBe('video/webm')
    expect(await body(response)).toEqual(content)
  })

  test('a partial range is 206 with only those bytes', async () => {
    const response = await fileResponse(file, request('bytes=16-31'), {})
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 16-31/256')
    expect(response.headers.get('content-length')).toBe('16')
    expect(await body(response)).toEqual(content.subarray(16, 32))
  })

  test('an open-ended range runs to the end', async () => {
    const response = await fileResponse(file, request('bytes=250-'), {})
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 250-255/256')
    expect(await body(response)).toEqual(content.subarray(250))
  })

  test('out of range is 416 and says how big the file is', async () => {
    const response = await fileResponse(file, request('bytes=256-'), {})
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */256')
    expect((await body(response)).length).toBe(0)
  })

  test('HEAD sends the headers without the bytes', async () => {
    const response = await fileResponse(file, request('bytes=0-9', 'HEAD'), {})
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('10')
    expect((await body(response)).length).toBe(0)
  })
})
