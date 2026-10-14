import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import type { SourceControlResult } from '../../src/shared/source-control'
import type { ShipInfo } from '../../src/shared/types'

function repository(root: string, branch = 'main', files = ['first.ts']): ShipInfo {
  return {
    blocked: null,
    branch,
    onDefaultBranch: branch === 'main',
    files: files.map((path) => ({ path, status: 'modified' })),
    skipped: [],
    remote: null,
    suggestion: { branch, title: `Suggestion for ${root}`, body: '' },
    workspace: {
      root,
      branch,
      head: 'a'.repeat(40),
      defaultBranch: 'main',
      branches: [],
      destination: null,
      ahead: 0,
      published: false,
      writeBlocked: null,
    },
  }
}
let info = repository('/project/first')
let complete: ((result: SourceControlResult) => void) | undefined
mock.module('../../src/renderer/src/lib/api', () => ({
  gui: {
    getShipInfo: async () => info,
    getProposal: async () => null,
    sourceControl: () =>
      new Promise<SourceControlResult>((resolve) => {
        complete = resolve
      }),
  },
}))
const shipping = await import('../../src/renderer/src/chat/shipping-state')
const state = () => shipping.useShipSheet.getState()
shipping.toggleShipSheet()
await shipping.loadShipInfo()
shipping.setShipDraft({ title: 'My draft', files: [] })
info = repository('/project/first', 'main', ['first.ts', 'new.ts'])
await shipping.loadShipInfo()
assert.equal(state().draft?.title, 'My draft')
assert.deepEqual(state().draft?.files, [], 'newly discovered files must remain excluded')
info = repository('/project/first', 'feature', ['first.ts', 'new.ts'])
await shipping.loadShipInfo()
assert.equal(state().draft?.branch, 'feature')
assert.deepEqual(state().draft?.files, [])

const operation = shipping.performSourceControl({
  kind: 'commit',
  title: 'Old project commit',
  body: '',
  files: ['first.ts'],
})
assert.equal(state().busy, true)
info = repository('/project/second', 'main', ['second.ts'])
await shipping.loadShipInfo()
assert.equal(state().draft?.title, 'Suggestion for /project/second')
assert.deepEqual(state().draft?.files, ['second.ts'])
assert.equal(state().busy, false)
assert.ok(complete)
complete({ outcome: 'committed', branch: 'feature', commit: 'old-sha' })
await operation
assert.equal(
  state().notice,
  null,
  'an old operation must not report success in a different project',
)
assert.equal(state().draft?.title, 'Suggestion for /project/second')

shipping.setShipDraft({ title: 'Typed during an agent turn', files: [] })
shipping.openShipSheet({
  mode: 'commit',
  title: 'New agent suggestion',
  body: '',
  files: ['second.ts'],
})
assert.equal(state().draft?.title, 'Typed during an agent turn')
assert.equal(state().pendingProposal?.title, 'New agent suggestion')
shipping.acceptShipProposal()
await shipping.loadShipInfo()
assert.equal(state().draft?.title, 'New agent suggestion')
assert.deepEqual(state().draft?.files, ['second.ts'])
shipping.closeShipSheet()
console.log('Source control draft refresh, project races and proposal preservation passed.')
