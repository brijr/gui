import { expect, test } from 'bun:test'
import { settleVersions } from '../src/main/history-format'

// The checkpoint save/restore round-trip itself is covered by tests/checkpoints.test.ts, and
// through the app by e2e/versions.spec.ts. What's pure here is how saved versions are read back.

test('saved versions load only when whole, keeping named and safety entries', () => {
  const id = '01234567-0123-0123-0123-0123456789ab'
  const named = {
    id,
    sha: 'a'.repeat(40),
    kind: 'named',
    name: '  Landing   page pass ',
    createdAt: 10,
    changes: [{ path: 'src/App.tsx', status: 'modified', additions: 3, deletions: 1 }],
  }
  const settled = settleVersions([
    named,
    {
      ...named,
      id: '12345678-1234-1234-1234-1234567890ab',
      kind: 'safety',
      name: 'Before restoring',
      changes: null,
    },
    { ...named, id: 'not-an-id', name: 'Bad id' },
    { ...named, id: '22345678-1234-1234-1234-1234567890ab', sha: 'not a sha' },
    { ...named, id: '32345678-1234-1234-1234-1234567890ab', kind: 'turn' },
    { ...named, id: '42345678-1234-1234-1234-1234567890ab', name: '   ' },
    { ...named, id: '52345678-1234-1234-1234-1234567890ab', createdAt: 'later' },
  ])
  expect(settled).toHaveLength(2)
  expect(settled?.[0]).toMatchObject({ kind: 'named', name: 'Landing page pass' })
  expect(settled?.[0]?.changes).toHaveLength(1)
  expect(settled?.[1]).toMatchObject({ kind: 'safety', changes: null })
})

test('history without versions invents none', () => {
  expect(settleVersions(undefined)).toBeUndefined()
  expect(settleVersions([])).toBeUndefined()
  expect(settleVersions('nope')).toBeUndefined()
})
