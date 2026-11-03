import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetName, saveAsset } from '../src/main/board-tool-workflow'

test('website screenshots are saved under a plain name inside assets/', () => {
  expect(assetName('Stripe Home')).toBe('stripe-home.jpg')
  expect(assetName('ref.PNG')).toBe('ref.jpg')
  expect(assetName('ref.jpeg')).toBe('ref.jpg')
  expect(assetName('../../etc/passwd')).toBe('etc-passwd.jpg')
  expect(assetName('/abs/path')).toBe('abs-path.jpg')
  expect(assetName('...')).toBe('screenshot.jpg')
})

test('a saved screenshot never replaces a file already in assets/', async () => {
  const base = await mkdtemp(join(tmpdir(), 'gui-asset-test-'))
  const dir = join(base, 'assets')
  const outside = join(base, 'outside.jpg')
  try {
    await mkdir(dir)
    await writeFile(outside, 'not yours')
    expect(await saveAsset(dir, assetName('ref'), Buffer.from('first'))).toBe('ref.jpg')
    // `ref.png` is `ref.jpg` too: the second gets its own name.
    expect(await saveAsset(dir, assetName('ref.png'), Buffer.from('second'))).toBe('ref-2.jpg')
    // A link planted at the next name is passed over, and what it points to is untouched.
    await symlink(outside, join(dir, 'ref-3.jpg'))
    expect(await saveAsset(dir, assetName('ref'), Buffer.from('third'))).toBe('ref-4.jpg')
    expect(await readFile(join(dir, 'ref.jpg'), 'utf8')).toBe('first')
    expect(await readFile(join(dir, 'ref-2.jpg'), 'utf8')).toBe('second')
    expect(await readFile(join(dir, 'ref-4.jpg'), 'utf8')).toBe('third')
    expect(await readFile(outside, 'utf8')).toBe('not yours')
    expect((await readdir(dir)).sort()).toEqual(['ref-2.jpg', 'ref-3.jpg', 'ref-4.jpg', 'ref.jpg'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
